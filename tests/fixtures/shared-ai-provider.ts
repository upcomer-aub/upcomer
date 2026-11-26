import type { MockFeedbackInput } from "@/lib/mock-ai-feedback-rules";
import type { PracticePromptInput } from "@/lib/ai-practice-rules";

export const fakeKey = "upcomer-e2e-fake-key";
export const fakePort = 3219;
export const draftRubric = {
  keyPoints: ["sequence numbers", "duplicate segment"],
  explanation: "Compare sequence numbers to discard a duplicate segment.",
};
export const practiceQuestion = (courseCode: string, index: number) =>
  `Explain how a receiver in scenario ${courseCode} handles retransmission ${index + 1} after receiving a duplicate.`;

export function practiceOutput(input: PracticePromptInput) {
  const source = input.sources[0];
  return { questions: Array.from({ length: input.count }, (_, index) => ({
    sourceRef: source.sourceRef, topicKey: source.topicKey, question: practiceQuestion(input.course.code, index), rubric: draftRubric,
  })) };
}

export function feedbackOutput(input: MockFeedbackInput) {
  return { explanation: `To address "${input.missedPoints[0]}", use the worked rubric to explain what the receiver checks.` };
}

export function envelope(output: unknown) {
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] };
}

export function requestData(body: string, start = "DATA_START", end = "DATA_END") {
  const { messages } = JSON.parse(body) as { messages: { role: string; content: string }[] };
  const user = messages.find(message => message.role === "user")?.content;
  const lines = user?.split("\n") ?? [];
  if (lines[0] !== start || lines[2] !== end) throw new Error("Expected delimited JSON data");
  return JSON.parse(lines[1]);
}
