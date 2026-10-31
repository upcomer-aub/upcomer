import { reportQuestionAction } from "@/lib/question-report-actions";
import { MAX_REPORT_NOTE_LENGTH, REPORT_REASONS } from "@/lib/question-report-rules";
import styles from "./report-question.module.css";

// The report form under one question of the Upcomer Exam (US-23). A plain POST to a server action, closed until opened.
export function ReportQuestionForm({ courseId, groupId, position }: { courseId: string; groupId: string; position: number }) {
  return <details className={styles.report}>
    <summary>Report a problem with question {position}</summary>
    <form className="form" action={reportQuestionAction}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="position" value={position} />
      <fieldset className="checkbox-list">
        <legend>What is wrong with question {position}?</legend>
        {REPORT_REASONS.map(reason => <label key={reason.value}><input type="radio" name="reason" value={reason.value} required /> {reason.label}</label>)}
      </fieldset>
      <label className="field">Details (optional)
        <textarea name="note" maxLength={MAX_REPORT_NOTE_LENGTH} rows={3} />
      </label>
      <button className="button" type="submit" aria-label={`Send report on question ${position}`}>Send report</button>
    </form>
  </details>;
}
