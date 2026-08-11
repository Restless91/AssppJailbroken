interface ProgressBarProps {
  progress: number;
  className?: string;
}

export default function ProgressBar({
  progress,
  className = "",
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div className={`progress-track w-full ${className}`}>
      <div
        className="progress-fill"
        data-busy={clamped > 0 && clamped < 100 ? "true" : undefined}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
