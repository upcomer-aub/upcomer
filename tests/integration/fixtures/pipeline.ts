import { db } from "@/lib/db";
// Pending submissions and materials are not processed automatically. These tests
// can still attach questions to prove that neither enters the public exam.
export async function extractQuestions(fileId: string, expected: readonly string[]) {
  await db.question.createMany({ data: expected.map((text, index) => ({ fileId, number: index + 1, text })) });
}
