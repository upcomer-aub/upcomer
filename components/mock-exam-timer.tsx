"use client";

import { useEffect, useRef, useState } from "react";
import { autosaveMockExamAction } from "@/app/courses/[courseId]/mock-exams/actions";
import {
  AUTOSAVE_INTERVAL_MS, crossedWarning, formatTimeLeft, MOCK_EXAM_GRACE_MS, TIME_UP_UNSAVED_NOTICE, timerLevel,
} from "@/lib/mock-exam-timing";
import styles from "./mock-exam-sitting.module.css";

// The countdown of a timed mock exam (US-48), inside the sitting form. The server is the only clock: `remainingMs` is the
// server's time left when the page was made, and every save's reply brings a new one. In between, the time is counted
// with performance.now(), which only moves forward, so changing the computer's clock cannot add time; a refresh asks the
// server again. This component decides nothing: the server refuses any save after the deadline whatever is shown here.
//
// It also keeps the typed answers safe: changed answers are saved every few seconds and when the tab is hidden, and at
// zero a final save is sent, which the server turns into the submission. If the server cannot be reached, the answers stay
// in their boxes and the save is retried until the grace has passed; then the page says what was and was not submitted.
// Without JavaScript nothing here runs: the time left at page load is shown, and the plain form and the server's deadline
// still work.

type Status = "saved" | "unsaved" | "saving" | "failed" | "signed_out" | "finishing" | "lost";
const STATUS_TEXT: Record<Status, string> = {
  saved: "All changes saved.",
  unsaved: "Unsaved changes. They are saved every few seconds.",
  saving: "Saving…",
  failed: "Not saved: check your connection. Retrying…",
  signed_out: "Not saved: you are logged out. Log in again in another tab; your answers stay here.",
  finishing: "Time is up. Submitting your answers…",
  lost: TIME_UP_UNSAVED_NOTICE,
};
const TICK_MS = 250;
const RETRY_MS = 2_000;

export function MockExamTimer({ remainingMs, examUrl }: { remainingMs: number; examUrl: string }) {
  const [left, setLeft] = useState(remainingMs);
  const [status, setStatus] = useState<Status>("saved");
  const [announcement, setAnnouncement] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = root.current?.closest("form");
    if (!form) return;
    // The server's time left, and the moment (on the monotonic clock) it was learned.
    let base = { remaining: remainingMs, at: performance.now() };
    let shown = remainingMs;
    let dirty = false;
    let busy = false;
    let ended = false;
    let lastAttempt = 0;
    const current = () => base.remaining - (performance.now() - base.at);
    const resync = (ms: number) => { base = { remaining: ms, at: performance.now() }; };

    const send = async (intent: "save" | "finish") => {
      const data = new FormData(form);
      data.set("intent", intent);
      try {
        return await autosaveMockExamAction(data);
      } catch {
        return { ok: false as const, error: "network" as const };
      }
    };
    const leave = () => { dirty = false; window.location.assign(examUrl); };

    const save = async () => {
      if (busy || ended) return;
      busy = true;
      const sentDirty = dirty;
      dirty = false;
      setStatus("saving");
      const result = await send("save");
      busy = false;
      if (ended) return;
      if (result.ok) {
        if (typeof result.remainingMs === "number") resync(result.remainingMs);
        setStatus(dirty ? "unsaved" : "saved");
      } else if (result.error === "time_up" || result.error === "already_submitted") {
        leave();
      } else {
        dirty = dirty || sentDirty;
        setStatus(result.error === "signed_out" ? "signed_out" : "failed");
      }
    };

    // At zero: one final save that the server turns into the submission. Retried while the grace lasts.
    const finish = async () => {
      if (busy) return;
      busy = true;
      ended = true;
      setStatus("finishing");
      for (const box of form.querySelectorAll("textarea")) box.readOnly = true;
      for (const button of form.querySelectorAll("button")) button.disabled = true;
      for (;;) {
        const result = await send("finish");
        if (result.ok && !result.timedOut && typeof result.remainingMs === "number" && result.remainingMs > 0) {
          // The server says there is time left (this clock ran fast): carry on.
          resync(result.remainingMs);
          for (const box of form.querySelectorAll("textarea")) box.readOnly = false;
          for (const button of form.querySelectorAll("button")) button.disabled = false;
          ended = false;
          busy = false;
          setStatus("saved");
          return;
        }
        if (result.ok || result.error === "time_up" || result.error === "already_submitted") return leave();
        if (current() < -MOCK_EXAM_GRACE_MS) break;
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
      // The server could not be reached in time: it submits the answers saved before. The typed text stays to be copied.
      dirty = false;
      setStatus("lost");
    };

    const tick = () => {
      const now = current();
      const said = crossedWarning(shown, Math.max(0, now));
      if (said) setAnnouncement(said);
      shown = Math.max(0, now);
      setLeft(shown);
      if (ended) return;
      if (now <= 0) void finish();
      else if (dirty && !busy && performance.now() - lastAttempt >= AUTOSAVE_INTERVAL_MS) {
        lastAttempt = performance.now();
        void save();
      }
    };
    const onInput = () => {
      if (ended) return;
      dirty = true;
      setStatus(previous => (previous === "saved" ? "unsaved" : previous));
    };
    // Leaving the tab saves what was typed; coming back asks the server for the time again (a sleeping laptop).
    const onVisibility = () => { if (!ended && !busy) void save(); };
    const onLeave = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };

    lastAttempt = performance.now();
    const timer = setInterval(tick, TICK_MS);
    form.addEventListener("input", onInput);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      clearInterval(timer);
      form.removeEventListener("input", onInput);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [remainingMs, examUrl]);

  const problem = status === "failed" || status === "signed_out" || status === "lost";
  return <div className={styles.timer} data-level={timerLevel(left)} ref={root}>
    <p className={styles.clock} role="timer" aria-live="off"><span>Time left</span> <strong data-testid="mock-timer">{formatTimeLeft(left)}</strong></p>
    <p className={problem ? styles.problem : "muted"} data-testid="mock-save-status" role={problem ? "alert" : undefined}>{STATUS_TEXT[status]}</p>
    {/* Screen readers hear only the warnings (5 minutes, 1 minute, time is up), never every second. */}
    <p className={styles.hidden} role="status" aria-live="polite" data-testid="mock-timer-announcement">{announcement}</p>
    <noscript><p className="muted">The timer doesn&apos;t count down without JavaScript, but the exam still ends on time.</p></noscript>
  </div>;
}
