import { cleanExtractedQuestion, isUsableQuestion } from "@/lib/question-content";
import { db } from "@/lib/db";
import { PUBLISHED_FILES } from "@/lib/file-visibility";
import { topicKey } from "@/lib/learning-profile";
import { logError } from "@/lib/logger";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";
import { contentHash, difficulties, GENERATOR_VERSION, groundedPrompts, sourceFingerprint, type GenerationError, type GenerationSettings } from "@/lib/practice-generation-rules";

class GenerationRefusal extends Error {
  constructor(public reason: GenerationError) { super(reason); }
}

type Provenance = {
  sourceFingerprint: string; topicKey: string;
  sourceQuestion: { text: string; excludedFromBank?: boolean; groupId?: string | null; file: { courseId: string; category: string; status: string; topic: string | null } };
};
const hasCurrentSource = (item: Provenance, courseId: string) =>
  isUsableQuestion(item.sourceQuestion) && item.sourceQuestion.groupId !== null && item.sourceQuestion.file.courseId === courseId && item.sourceQuestion.file.category === "EXAM"
  && item.sourceQuestion.file.status === "PUBLISHED" && item.sourceFingerprint === sourceFingerprint(item.sourceQuestion.text)
  && item.topicKey === topicKey(item.sourceQuestion.file.topic);

// US-44. Persisted item IDs and provenance are the input contract for US-45 mock assembly. No new tasks are inserted
// into the historical Question/QuestionGroup tables, so generation never changes exam-frequency statistics.
export async function generatePracticeQuestions(userId: string, courseId: string, settings: GenerationSettings) {
  if (!Number.isInteger(settings.count) || settings.count < 1 || settings.count > 10 || !difficulties.includes(settings.difficulty)
    || (settings.topicKey?.length ?? 0) > 100) return { ok: false as const, error: "invalid_settings" as GenerationError };
  if (!checkRateLimit(`generate-practice:${userId}`, limitFromEnv("PRACTICE_GENERATION_RATE_LIMIT_PER_MINUTE", 20), 60_000).ok) {
    logError("practice_generation_refused", { userId, courseId, reason: "rate_limited" });
    return { ok: false as const, error: "rate_limited" as GenerationError };
  }
  try {
    const questions = await db.$transaction(async tx => {
      // Same course lock as regroup/removal: provenance cannot disappear midway through generation.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${courseId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation:${userId}:${courseId}`}))`;
      if (!await tx.course.findUnique({ where: { id: courseId }, select: { id: true } })) throw new GenerationRefusal("not_found");
      const sources = await tx.question.findMany({
        where: { excludedFromBank: false, file: { courseId, category: "EXAM", ...PUBLISHED_FILES }, groupId: { not: null } },
        include: { file: { select: { topic: true } } }, orderBy: [{ fileId: "asc" }, { number: "asc" }],
      });
      const eligible = sources.filter(source => isUsableQuestion(source) && topicKey(source.file.topic) && (!settings.topicKey || topicKey(source.file.topic) === settings.topicKey) && source.text.trim().length >= 10 && source.text.length <= 12_000);
      if (!eligible.length) throw new GenerationRefusal("no_sources");
      const existing = await tx.generatedPracticeQuestion.findMany({
        where: { userId, courseId }, include: { sourceQuestion: { select: { text: true, excludedFromBank: true, groupId: true, file: { select: { courseId: true, category: true, status: true, topic: true } } } } },
      });
      const stale = existing.filter(item => !hasCurrentSource(item, courseId));
      // Invalidated items are no longer usable by mocks. Free their unique hashes before regenerating an identical
      // task under corrected topic metadata; event snapshots survive with a null generatedQuestionId.
      if (stale.length) await tx.generatedPracticeQuestion.deleteMany({ where: { userId, courseId, id: { in: stale.map(item => item.id) } } });
      const seen = new Set([
        ...sources.map(source => contentHash(source.text)),
        ...existing.filter(item => hasCurrentSource(item, courseId)).map(item => item.contentHash),
      ]);
      const selected: Array<{ source: typeof eligible[number]; prompt: string; hash: string }> = [];
      // Round-robin tasks across papers before taking a second task from the same source.
      for (let variant = 0; variant < 3 && selected.length < settings.count; variant++) {
        for (const source of eligible) {
          const prompt = groundedPrompts(cleanExtractedQuestion(source.text), settings.difficulty)[variant];
          const hash = contentHash(prompt);
          if (seen.has(hash)) continue;
          seen.add(hash);
          selected.push({ source, prompt, hash });
          if (selected.length === settings.count) break;
        }
      }
      if (selected.length !== settings.count) throw new GenerationRefusal("insufficient_novel_questions");
      const created = [];
      for (const { source, prompt, hash } of selected) created.push(await tx.generatedPracticeQuestion.create({ data: {
        userId, courseId, sourceQuestionId: source.id, sourceFingerprint: sourceFingerprint(source.text),
        topicKey: topicKey(source.file.topic), topic: source.file.topic!.replace(/\s+/g, " ").trim(),
        difficulty: settings.difficulty, prompt, contentHash: hash, generatorVersion: GENERATOR_VERSION,
      } }));
      return created;
    }, { maxWait: 10_000, timeout: 30_000 });
    logError("practice_generation_completed", { userId, courseId, questionCount: String(questions.length), difficulty: settings.difficulty });
    return { ok: true as const, questions };
  } catch (error) {
    const reason = error instanceof GenerationRefusal ? error.reason : "unexpected";
    logError(reason === "unexpected" ? "practice_generation_failed" : "practice_generation_refused", { userId, courseId, reason, errorType: error instanceof Error ? error.name : "Unknown" });
    return { ok: false as const, error: reason };
  }
}

// US-45/46/47 callers use this instead of reading the table directly. Only this student's items, still matching a
// published source in the same course, are eligible. No ungrounded or stale question is returned after source edits.
export async function getGeneratedPracticeQuestions(userId: string, courseId: string, settings: Partial<GenerationSettings> = {}) {
  try {
    const questions = await db.generatedPracticeQuestion.findMany({
      where: { userId, courseId, ...(settings.difficulty && { difficulty: settings.difficulty }), ...(settings.topicKey && { topicKey: settings.topicKey }), sourceQuestion: { excludedFromBank: false, groupId: { not: null }, file: { courseId, category: "EXAM", ...PUBLISHED_FILES } } },
      include: { sourceQuestion: { select: { text: true, excludedFromBank: true, groupId: true, fileId: true, file: { select: { title: true, topic: true, courseId: true, category: true, status: true } } } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return questions.filter(item => hasCurrentSource(item, courseId));
  } catch (error) {
    logError("practice_generation_failed", { userId, courseId, operation: "read", errorType: error instanceof Error ? error.name : "Unknown" });
    throw error;
  }
}
