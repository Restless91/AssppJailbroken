import { useTranslation } from "react-i18next";

interface BadgeProps {
  status:
    | "pending"
    | "downloading"
    | "paused"
    | "injecting"
    | "decrypting"
    | "completed"
    | "failed";
}

type Tone = "default" | "success" | "accent" | "warning" | "danger";

const tones: Record<BadgeProps["status"], Tone> = {
  pending: "default",
  downloading: "accent",
  paused: "warning",
  injecting: "accent",
  decrypting: "accent",
  completed: "success",
  failed: "danger",
};

export default function Badge({ status }: BadgeProps) {
  const { t } = useTranslation();

  return (
    <span
      className="chip"
      data-tone={tones[status] === "default" ? undefined : tones[status]}
    >
      {/* Dynamic lookup matching the JSON structure "downloads.status.xxx" */}
      {t(`downloads.status.${status}`)}
    </span>
  );
}
