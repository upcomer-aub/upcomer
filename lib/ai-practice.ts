import { aiConfig, runAiPrompt } from "@/lib/ai-client";
import { AI_PRACTICE_VERSION, aiPracticePrompt, choosePracticeSources, MAX_PRACTICE_SOURCE_LENGTH } from "@/lib/ai-practice-rules";
import { db } from "@/lib/db";
import { getLearningProfile, topicKey } from "@/lib/learning-profile";
import { errorCode, logError } from "@/lib/logger";
import { contentHash, sourceFingerprint, validGenerationSettings, type GenerationError, type GenerationSettings } from "@/lib/practice-generation-rules";
import { lockPracticeSources, publishedPracticeSources } from "@/lib/practice-source";
import { cleanExtractedQuestion, isUsableQuestion } from "@/lib/question-content";
import { checkRateLimit, limitFromEnv } from "@/lib/rate-limit";

export const aiPracticeAvailable = () => process.env.AI_PRACTICE_GENERATION_ENABLED === "true" && Boolean(aiConfig());

export async function generateAiPracticeQuestions(userId: string, courseId: string, settings: GenerationSettings) {
  const fail = (error: GenerationError) => ({ ok: false as const, error });
  if (!validGenerationSettings(settings)) return fail("invalid_settings");
  if (!aiPracticeAvailable()) return fail("ai_unavailable");

  try {
    const course = await db.course.findUnique({ where: { id: courseId }, select: { code: true, name: true } });
    if (!course) return fail("not_found");
    const sources = await db.question.findMany({
      where: publishedPracticeSources(courseId),
      select: { id: true, text: true, fileId: true, file: { select: { topic: true } } },
      orderBy: [{ fileId: "asc" }, { number: "asc" }, { id: "asc" }],
    });
    const eligible = sources.flatMap(source => {
      const key = topicKey(source.file.topic);
      const label = source.file.topic?.replace(/\s+/g, " ").trim();
      const excerpt = cleanExtractedQuestion(source.text).slice(0, MAX_PRACTICE_SOURCE_LENGTH).trim();
      if (!key || !label || key.length > 100 || excerpt.length < 10 || !isUsableQuestion(source)) return [];
      return [{ sourceRef: source.id, topicKey: key, label, excerpt, fingerprint: sourceFingerprint(source.text), fileId: source.fileId }];
    });
    const profile = settings.topicKey ? undefined : await getLearningProfile(userId, courseId).catch(() => undefined);
    const chosen = choosePracticeSources(eligible, settings.topicKey, profile);
    if (!chosen.length) return fail("no_sources");

    if (!checkRateLimit(`ai-practice:${userId}`, limitFromEnv("AI_PRACTICE_RATE_LIMIT_PER_HOUR", 5), 3_600_000).ok) return fail("ai_rate_limited");
    const topics = [...new Map(chosen.map(source => [source.topicKey, { key: source.topicKey, label: source.label }])).values()];
    const answer = await runAiPrompt(aiPracticePrompt, { course, topics, sources: chosen, count: settings.count, difficulty: settings.difficulty });
    if (!answer.ok) return fail(answer.error === "not_configured" ? "ai_unavailable" : "ai_failed");

    const selected = new Map(chosen.map(source => [source.sourceRef, source]));
    return await db.$transaction(async tx => {
      await lockPracticeSources(tx, courseId, chosen.map(source => source.sourceRef));
      const bank = await tx.question.findMany({
        where: publishedPracticeSources(courseId, false),
        select: { id: true, text: true, fileId: true, group: { select: { text: true } }, file: { select: { topic: true } } },
      });
      const current = new Map(bank.map(source => [source.id, source]));
      for (const before of chosen) {
        const after = current.get(before.sourceRef);
        if (!after?.group || !isUsableQuestion(after) || before.fileId !== after.fileId
          || before.fingerprint !== sourceFingerprint(after.text) || before.topicKey !== topicKey(after.file.topic)) return fail("source_changed");
      }
      const saved = await tx.generatedPracticeQuestion.findMany({ where: { userId, courseId }, select: { contentHash: true } });
      const seen = new Set(saved.map(item => item.contentHash));
      for (const source of bank) {
        if (isUsableQuestion(source)) {
          seen.add(contentHash(source.text));
          seen.add(contentHash(cleanExtractedQuestion(source.text)));
          if (source.group) seen.add(contentHash(source.group.text));
        }
      }
      const batch = answer.value.map(item => ({ item, hash: contentHash(item.question) }));
      if (batch.some(({ hash }) => seen.has(hash))) return fail("insufficient_novel_questions");
      const questions = await tx.generatedPracticeQuestion.createManyAndReturn({
        data: batch.map(({ item, hash }) => ({
          userId, courseId, sourceQuestionId: item.sourceRef, sourceFingerprint: selected.get(item.sourceRef)!.fingerprint,
          topicKey: item.topicKey, topic: current.get(item.sourceRef)!.file.topic!.replace(/\s+/g, " ").trim(),
          difficulty: settings.difficulty, prompt: item.question, contentHash: hash, generatorVersion: AI_PRACTICE_VERSION,
          aiModel: answer.model, aiPromptVersion: AI_PRACTICE_VERSION, rubric: item.rubric, rubricStatus: "DRAFT",
        })),
      });
      return { ok: true as const, questions };
    }, { maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (errorCode(error) === "P2002") return fail("insufficient_novel_questions");
    logError("practice_generation_failed", { userId, courseId, operation: "ai_generate", errorCode: errorCode(error) });
    return fail("unexpected");
  }
}
