import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { retryExamAction } from "@/lib/exam-processing-actions";
import { canRetryRun, getExamProcessingRuns, processingReason } from "@/lib/exam-processing";

export const dynamic = "force-dynamic";

export default async function ProcessingPage({ searchParams }: { searchParams: Promise<{ retried?: string; error?: string }> }) {
  await requireAdmin("/admin/processing");
  const { retried, error } = await searchParams;
  const files = await getExamProcessingRuns();
  return <><Link className="back" href="/admin/uploads">← Back to uploads</Link><span className="eyebrow">Admin</span><h1>Exam processing</h1>
    <p className="muted">Each uploaded or approved PDF is checked for questions. Failed attempts can be retried after the file is fixed.</p>
    {retried && <p className="notice" role="status">Processing was retried. See its latest result below.</p>}
    {error && <p className="notice error" role="alert">This exam cannot be retried right now.</p>}
    {files.length ? <ul className="list catalog-list">{files.map(file => {
      const run = file.processingRuns[0];
      const interrupted = run.status === "RUNNING" && canRetryRun(run);
      return <li className="card" key={file.id}><span className="eyebrow">{file.course.code}</span><h2>{file.title}</h2>
        <p>Status: {run.status === "SUCCEEDED" ? "Completed" : run.status === "RUNNING" && !interrupted ? "Processing" : "Failed"}</p>
        {canRetryRun(run) && <><p>Stage: {run.stage === "EXTRACTION" ? "Text extraction" : "Question grouping"}</p>
          <p role="alert">Reason: {interrupted ? "Processing stopped before a result was recorded." : processingReason(run.reason)}</p>
          <form action={retryExamAction}><input type="hidden" name="fileId" value={file.id} /><button className="button" type="submit">Retry</button></form></>}
      </li>;
    })}</ul> : <p className="card muted">No exams have been processed yet.</p>}
  </>;
}
