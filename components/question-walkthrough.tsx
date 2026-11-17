import { generateWalkthroughAction } from "@/lib/walkthrough-actions";
import { UNVERIFIED_REASON_LABELS, type WalkthroughStep } from "@/lib/walkthrough-rules";
import styles from "./question-walkthrough.module.css";
import { WalkthroughSubmitButton } from "./walkthrough-submit-button";

// US-51: a stored walkthrough, and the form that makes one. All text is rendered as plain React text (never as HTML), so
// anything the model wrote is shown literally. Each step says in words whether it is quoted from the question or unverified,
// so color is never the only difference.

const when = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function WalkthroughSteps({ steps, createdAt }: { steps: WalkthroughStep[]; createdAt: Date }) {
  const unverified = steps.filter(step => !step.verified).length;
  return <section className={styles.walkthrough} aria-labelledby="walkthrough-heading">
    <h2 id="walkthrough-heading">Walkthrough</h2>
    <p className={styles.summary} data-summary>
      {steps.length} steps. {unverified === 0
        ? "Every step quotes the question."
        : `${unverified} of ${steps.length} steps ${unverified === 1 ? "is" : "are"} unverified: ${unverified === 1 ? "it does" : "they do"} not come from the question's own words.`}
      {" "}Steps were checked against the question text only, not against an answer key.
    </p>
    <ol className={styles.steps}>{steps.map((step, index) => <li className={`card ${styles.step}`} key={index} data-verified={step.verified}>
      <h3 className={styles.title}><span className={styles.number}>Step {index + 1}:</span> {step.title}</h3>
      {step.verified
        ? <p className={styles.status}><span className={`${styles.badge} ${styles.quoted}`}>Quoted from the question</span></p>
        : <p className={styles.status}><span className={`${styles.badge} ${styles.unverified}`}>Unverified</span> <span className="muted">{step.unverifiedReason ? UNVERIFIED_REASON_LABELS[step.unverifiedReason] : ""}</span></p>}
      {step.verified && step.quote && <blockquote className={styles.quote}><span className={styles.visuallyHidden}>From the question: </span>{step.quote}</blockquote>}
      <p className={styles.explanation}>{step.explanation}</p>
    </li>)}</ol>
    <p className="muted">Generated <time dateTime={createdAt.toISOString()}>{when(createdAt)}</time>. The same walkthrough is shown to every student.</p>
  </section>;
}

// "Generate walkthrough", or "Try again" after a failure that may pass. A plain POST form; the note says it can take a
// while. With JavaScript the button is disabled while waiting (WalkthroughSubmitButton); without it, a second click joins the
// same request on the server (no second AI call, no extra count).
export function WalkthroughGenerateForm({ courseId, questionId, retry }: { courseId: string; questionId: string; retry: boolean }) {
  return <section className={styles.generate} aria-labelledby="generate-heading">
    <h2 id="generate-heading">Walkthrough</h2>
    {!retry && <p>No walkthrough has been made for this question yet.</p>}
    <form className={styles.form} action={generateWalkthroughAction}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="questionId" value={questionId} />
      <WalkthroughSubmitButton label={retry ? "Try again" : "Generate walkthrough"} describedBy="generate-note" />
      <p className="muted" id="generate-note">Preparing a walkthrough can take up to a minute. Click once and wait: the page reloads by itself when it is ready.</p>
    </form>
  </section>;
}
