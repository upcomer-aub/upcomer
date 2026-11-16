"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createMockExamAction, type MockExamFormState } from "@/app/courses/[courseId]/mock-exams/actions";
import {
  DIFFICULTY_HELP, DIFFICULTY_LABELS, MOCK_EXAM_DEFAULT_LENGTH, MOCK_EXAM_DIFFICULTIES, MOCK_EXAM_MAX_LENGTH, MOCK_EXAM_MIN_LENGTH,
  mockExamMessage, type MockExamOptions,
} from "@/lib/mock-exam-rules";

// The settings of a mock exam (US-45): topics, length, difficulty, and whether to mix in the student's generated practice
// questions (US-44). A plain POST to a server action, so it works without JavaScript; the server checks every setting
// again. The typed settings come back in the state after a refusal (the same pattern as the profile form), so the form
// keeps them.
export function MockExamForm({ courseId, options }: { courseId: string; options: MockExamOptions }) {
  const [state, formAction, pending] = useActionState(createMockExamAction, { status: "idle" } as MockExamFormState);
  const values = state.values;
  const chosen = new Set(values?.topics ?? []);
  // key: a refused attempt re-renders the fields with what was chosen, even after React resets the form.
  const attempt = values ? JSON.stringify(values) : "new";
  return <form className="card form" action={formAction}>
    <input type="hidden" name="courseId" value={courseId} />
    {state.status === "error" && <p className="notice error" role="alert">{mockExamMessage(state.error ?? "unexpected", state.available)}</p>}
    {options.topics.length > 0 && <fieldset className="checkbox-list" key={`topics-${attempt}`}>
      <legend>Topics</legend>
      <p className="muted">Leave all unticked to use every topic. More questions come from the topics you rated weaker and the topics that come up most in past papers.</p>
      {options.topics.map(topic => <label key={topic.key}>
        <input type="checkbox" name="topic" value={topic.key} defaultChecked={chosen.has(topic.key)} /> {topic.label} ({topic.count} {topic.count === 1 ? "question" : "questions"})
      </label>)}
    </fieldset>}
    <label className="field" key={`length-${attempt}`}><span>Number of questions</span>
      <input type="number" name="length" inputMode="numeric" min={MOCK_EXAM_MIN_LENGTH} max={MOCK_EXAM_MAX_LENGTH} defaultValue={values?.length ?? String(MOCK_EXAM_DEFAULT_LENGTH)} required />
      <span className="muted">{MOCK_EXAM_MIN_LENGTH} to {MOCK_EXAM_MAX_LENGTH}. This course has {options.total} {options.total === 1 ? "question" : "questions"} from past papers.</span>
    </label>
    <label className="field" key={`difficulty-${attempt}`}><span>Difficulty</span>
      <select name="difficulty" defaultValue={values?.difficulty ?? "MIXED"}>
        {MOCK_EXAM_DIFFICULTIES.map(item => <option key={item} value={item}>{DIFFICULTY_LABELS[item]}</option>)}
      </select>
      <span className="muted">{DIFFICULTY_HELP}</span>
    </label>
    {options.generated > 0
      ? <div className="checkbox-list" key={`generated-${attempt}`}>
        <label><input type="checkbox" name="includeGenerated" defaultChecked={values?.includeGenerated ?? false} /> Include my generated practice questions ({options.generated} available)</label>
        <p className="muted">Up to half of the exam. Only generated questions of the chosen topics and difficulty are used; the rest come from past papers.</p>
      </div>
      : <p className="muted">You have no generated practice questions for this course. <Link href={`/courses/${courseId}/practice/generated`}>Generate some</Link> to mix them into a mock exam.</p>}
    <button className="button" type="submit" disabled={pending}>{pending ? "Generating…" : "Generate mock exam"}</button>
  </form>;
}
