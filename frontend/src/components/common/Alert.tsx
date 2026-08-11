const tones = {
  error: "error",
  success: "success",
  warning: "warning",
} as const;

export default function Alert({
  type,
  children,
  className = "",
}: {
  type: keyof typeof tones;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`alert ${className}`}
      data-tone={tones[type]}
    >
      {children}
    </div>
  );
}
