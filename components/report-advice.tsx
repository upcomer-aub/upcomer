import { reportAdviceAction } from "@/lib/advice-report-actions";
import { ADVICE_REPORT_REASONS, MAX_ADVICE_REPORT_NOTE_LENGTH } from "@/lib/advice-report-rules";
import styles from "./report-question.module.css";

// The report form under one piece of advice in the course feed (US-43). A plain POST to a server action, closed until
// opened. Shown only on other students' advice the viewer has not already reported.
export function ReportAdviceForm({ courseId, adviceId, page }: { courseId: string; adviceId: string; page: number }) {
  return <details className={styles.report}>
    <summary>Report this advice</summary>
    <form className="form" action={reportAdviceAction}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="adviceId" value={adviceId} />
      <input type="hidden" name="page" value={page} />
      <fieldset className="checkbox-list">
        <legend>What is wrong with this advice?</legend>
        {ADVICE_REPORT_REASONS.map(reason => <label key={reason.value}><input type="radio" name="reason" value={reason.value} required /> {reason.label}</label>)}
      </fieldset>
      <label className="field">Details for the admin (optional)
        <textarea name="note" maxLength={MAX_ADVICE_REPORT_NOTE_LENGTH} rows={3} />
      </label>
      <p className="muted">Only admins see your report. The author is not told who reported it.</p>
      <button className="button" type="submit">Send report</button>
    </form>
  </details>;
}
