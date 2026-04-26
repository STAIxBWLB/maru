import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

interface FieldProps {
  label: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, helper, error, children }: FieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {helper ? <span className="field-helper">{helper}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`text-input ${props.className ?? ""}`} {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`text-area ${props.className ?? ""}`} {...props} />;
}
