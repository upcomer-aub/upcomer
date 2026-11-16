import Link from "next/link";
import { notFound } from "next/navigation";
import { saveAnswerKeyAction } from "@/lib/answer-key-actions";
import { requireAdmin } from "@/lib/auth";
import { getAnswerKeyGroup } from "@/lib/mock-marking";
import { ANSWER_KEY_EXPLANATION_MAX_LENGTH, ANSWER_KEY_MAX_POINTS, answerKeyMessage } from "@/lib/mock-marking-rules";

export const dynamic = "force-dynamic";

// Writing the answer key of one question group (US-49): the key points a full answer covers, one per line, and an
// explanation students see when they miss a point.
export default async function AnswerKeyPage({ params, searchParams }: {
  params: Promise<{ courseId: string; groupId: string }>; searchParams: Promise<{ error?: string }>;
}) {
  const { courseId, groupId } = await params;
  const { error } = await searchParams;
  const list = `/admin/answer-keys/${encodeURIComponent(courseId)}`;
  await requireAdmin(`${list}/${encodeURIComponent(groupId)}`);
  const group = await getAnswerKeyGroup(courseId, groupId);
  if (!group) notFound();
  return <><Link className="back" href={list}>← Back to the answer keys</Link><span className="eyebrow">Admin · question #{group.rank}</span><h1>Answer Key</h1>
    <article className="card"><p style={{ whiteSpace: "pre-wrap" }}>{group.text}</p></article>
    {error && <p className="notice" role="alert">{answerKeyMessage(error)}</p>}
    <form className="card form" action={saveAnswerKeyAction}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="groupId" value={group.id} />
      <label className="field">Key points, one per line (at most {ANSWER_KEY_MAX_POINTS})
        <span className="muted">An answer covers a point when it contains every important word of it, in any order. Keep each point short, for example &quot;SYN, SYN-ACK, ACK&quot;.</span>
        <textarea name="keyPoints" rows={6} required defaultValue={group.answerKey?.keyPoints.join("\n") ?? ""} />
      </label>
      <label className="field">Explanation for students (optional)
        <textarea name="explanation" rows={5} maxLength={ANSWER_KEY_EXPLANATION_MAX_LENGTH} defaultValue={group.answerKey?.explanation ?? ""} />
      </label>
      <button className="button" type="submit" name="intent" value="save">Save the answer key</button>
      {group.answerKey && <button className="button danger" type="submit" name="intent" value="remove" formNoValidate>Remove the answer key</button>}
    </form>
  </>;
}
