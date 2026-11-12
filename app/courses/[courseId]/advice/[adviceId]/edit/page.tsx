import Link from "next/link";
import { notFound } from "next/navigation";
import { AdviceAbout } from "@/components/advice-list";
import { deleteAdviceAction, editAdviceAction } from "@/lib/advice-actions";
import { getOwnAdvice } from "@/lib/advice-changes";
import { adviceChangeMessage, ANONYMOUS_AUTHOR, MAX_ADVICE_LENGTH, MAX_RESOURCE_URL_LENGTH } from "@/lib/advice-rules";
import { requireUser } from "@/lib/auth";
import styles from "./edit.module.css";

export const dynamic = "force-dynamic";

// An author edits or deletes their own advice (US-36). Anyone else's advice, advice that is no longer shown, and advice
// that does not exist all show the same not-found page.
export default async function EditAdvicePage({ params, searchParams }: {
  params: Promise<{ courseId: string; adviceId: string }>; searchParams: Promise<{ error?: string; page?: string }>;
}) {
  const { courseId, adviceId } = await params;
  const { error, page } = await searchParams;
  const feed = `/courses/${encodeURIComponent(courseId)}/advice`;
  const user = await requireUser(`${feed}/${encodeURIComponent(adviceId)}/edit`);
  const advice = await getOwnAdvice(user.id, courseId, adviceId);
  if (!advice) notFound();
  const feedPage = Number(page);
  const returnPage = Number.isInteger(feedPage) && feedPage > 1 ? feedPage : 1;
  const back = `${feed}${returnPage > 1 ? `?page=${returnPage}` : ""}#advice-${encodeURIComponent(advice.id)}`;
  const hidden = <>
    <input type="hidden" name="courseId" value={advice.courseId} />
    <input type="hidden" name="adviceId" value={advice.id} />
    <input type="hidden" name="page" value={returnPage} />
  </>;
  return <>
    <Link className="back" href={back}>← Back to the advice</Link>
    <span className="eyebrow">Your advice</span><h1>Edit your advice</h1>
    <p className="muted"><AdviceAbout courseId={advice.courseId} about={advice.about} /></p>
    {advice.anonymous && <p className="muted">Other students see this advice as by {ANONYMOUS_AUTHOR}.</p>}
    {error && <p className="notice error" role="alert">{adviceChangeMessage(error)}</p>}
    <form className="card form" action={editAdviceAction}>
      {hidden}
      <label className="field">Your advice
        <textarea name="body" required maxLength={MAX_ADVICE_LENGTH} rows={8} defaultValue={advice.body} />
      </label>
      <label className="field">Resource link (optional) <span className="muted">A full https:// address. Leave it empty to remove the link.</span>
        <input name="resourceUrl" type="url" maxLength={MAX_RESOURCE_URL_LENGTH} defaultValue={advice.resourceUrl ?? ""} placeholder="https://" />
      </label>
      <button className="button" type="submit">Save changes</button>
    </form>
    <section className={`card form ${styles.deleteSection}`} aria-labelledby="delete-advice">
      <h2 id="delete-advice">Delete this advice</h2>
      <p className="muted">Other students will no longer see it. This cannot be undone.</p>
      <form action={deleteAdviceAction}>
        {hidden}
        <button className={`button ${styles.delete}`} type="submit">Delete advice</button>
      </form>
    </section>
  </>;
}
