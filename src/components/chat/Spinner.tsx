export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 motion-reduce:animate-none"
    />
  );
}
