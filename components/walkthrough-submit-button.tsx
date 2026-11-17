"use client";

import { useFormStatus } from "react-dom";
import styles from "./question-walkthrough.module.css";

export const GENERATING_TEXT = "Generating, this can take up to a minute…";

// US-51: the Generate / Try again button. While its form is being sent it is disabled and says that generating can take up to
// a minute, which a screen reader hears through the status line. Without JavaScript it is a plain submit button (the server
// already joins a second click to the request in progress).
export function WalkthroughSubmitButton({ label, describedBy }: { label: string; describedBy: string }) {
  const { pending } = useFormStatus();
  return <>
    <button className="button" type="submit" disabled={pending} aria-describedby={describedBy}>{pending ? GENERATING_TEXT : label}</button>
    <span className={styles.visuallyHidden} role="status">{pending ? GENERATING_TEXT : ""}</span>
  </>;
}
