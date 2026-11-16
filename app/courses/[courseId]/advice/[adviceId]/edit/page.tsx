import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteAdviceAction, editAdviceAction } from "@/lib/advice-change-actions";
import { adviceChangeMessage, getOwnAdvice } from "@/lib/advice-changes";
import { ADVICE_BODY_MAX_LENGTH, ADVICE_LINK_TITLE_MAX_LENGTH, ADVICE_TITLE_MAX_LENGTH, ANONYMOUS_AUTHOR_LABEL } from "@/lib/advice-rules";
import { requireUser } from "@/lib/auth";

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
  const back = `${feed}${returnPage > 1 ? `?page=${returnPage}` : ""}`;
  const hidden = <>
    <input type="hidden" name="courseId" value={advice.courseId} />
    <input type="hidden" name="adviceId" value={advice.id} />
    <input type="hidden" name="page" value={returnPage} />
  </>;
  return <>
    <Link className="back" href={back}>← Back to the advice</Link>
    <span className="eyebrow">Your advice</span><h1>Edit your advice</h1>
    <p className="muted">About: {advice.about}</p>
    {advice.isAnonymous && <p className="muted">Other students see this advice as by {ANONYMOUS_AUTHOR_LABEL}.</p>}
    {error && <p className="notice" role="alert">{adviceChangeMessage(error)}</p>}
    <form className="card form" action={editAdviceAction}>
      {hidden}
      <label className="field">Title
        <input name="title" required maxLength={ADVICE_TITLE_MAX_LENGTH} defaultValue={advice.title} />
      </label>
      <label className="field">Your advice
        <textarea name="body" required maxLength={ADVICE_BODY_MAX_LENGTH} rows={8} defaultValue={advice.body} />
      </label>
      <label className="field">Helpful link (optional, must start with https://; leave it empty to remove the link)
        <input name="resourceUrl" type="url" defaultValue={advice.resourceUrl ?? ""} placeholder="https://" />
      </label>
      <label className="field">Link name (optional)
        <input name="resourceTitle" maxLength={ADVICE_LINK_TITLE_MAX_LENGTH} defaultValue={advice.resourceTitle ?? ""} />
      </label>
      <button className="button" type="submit">Save changes</button>
    </form>
    <section className="card form" aria-labelledby="delete-advice">
      <h2 id="delete-advice">Delete this advice</h2>
      <p className="muted">Other students will no longer see it. This cannot be undone.</p>
      <form action={deleteAdviceAction}>
        {hidden}
        <button className="button danger" type="submit">Delete advice</button>
      </form>
    </section>
  </>;
}
