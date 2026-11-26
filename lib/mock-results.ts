import { logError } from "@/lib/logger";
import { getMockExam } from "@/lib/mock-exams";
import { eligibleForAiFeedback } from "@/lib/mock-ai-feedback-rules";
import { markMockExam } from "@/lib/mock-marking";
import { buildResultsReport, type ResultsReport } from "@/lib/mock-results-rules";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { timed } from "@/lib/timing";

// The results report of a student's own mock exam (US-50), built from its stored marking (US-49). Only the exam's student
// gets it: the exam is read by its ID and the session user's ID. A submitted exam that is not marked yet is marked first,
// so the report is never built from unmarked answers. Nothing here checks the session: the page calls requireUser()
// first. Answers are never logged.

const errorType = (error: unknown) => (error instanceof Error ? error.name : "Unknown");

// DoS protection: results pages per student per minute. Far above what a person opens.
export const RESULTS_WINDOW_MS = 60_000;
export const resultsLimit = () => limitFromEnv("MOCK_RESULTS_RATE_LIMIT_PER_MINUTE", 60);

export function allowResultsRead(userId: string) {
  const limit = checkRateLimit(`mock-results:${userId}`, resultsLimit(), RESULTS_WINDOW_MS);
  if (limit.ok) return true;
  logError("mock_results_rate_limited", { userId, retryAfterSeconds: String(limit.retryAfterSeconds) });
  return false;
}

export type MockResults =
  | { ok: true; exam: { id: string; courseId: string; markedAt: Date }; report: ResultsReport }
  | { ok: false; error: "not_found" | "not_submitted" | "not_marked" };

export async function getMockResults(userId: string, mockExamId: string): Promise<MockResults> {
  const context = { userId, mockExamId: mockExamId.slice(0, 100) };
  try {
    return await timed("mock_results", context, async (): Promise<MockResults> => {
      let exam = await getMockExam(userId, mockExamId, true);
      if (!exam) return { ok: false, error: "not_found" };
      if (exam.status !== "SUBMITTED") return { ok: false, error: "not_submitted" };
      if (!exam.markedAt) {
        await markMockExam(userId, exam.id);
        exam = await getMockExam(userId, mockExamId, true);
        if (!exam?.markedAt) return { ok: false, error: "not_marked" };
      }
      const questions = exam.questions.map(({ id, position, topic, text, outcome, matchedPoints, missedPoints, feedback, answer, aiExplanations }) => ({
        id, position, topic, text, outcome, matchedPoints, missedPoints, feedback,
        aiFeedbackEligible: eligibleForAiFeedback({ answer, outcome, missedPoints }),
        aiExplanation: aiExplanations?.[0]?.explanation,
      }));
      return { ok: true, exam: { id: exam.id, courseId: exam.courseId, markedAt: exam.markedAt }, report: buildResultsReport(questions) };
    });
  } catch (error) {
    logError("mock_results_retrieval_failed", { ...context, errorType: errorType(error) });
    throw error;
  }
}
