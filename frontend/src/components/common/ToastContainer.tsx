import type { ReactNode } from "react";
import { useToastStore, type ToastType } from "../../store/toast";

const iconBg: Record<ToastType, string> = {
  success: "bg-success-soft",
  error: "bg-danger-soft",
  info: "bg-accent-soft",
};

const titleColor: Record<ToastType, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-accent",
};

const icons: Record<ToastType, ReactNode> = {
  success: (
    <svg
      className="w-5 h-5 text-success"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  ),
  error: (
    <svg
      className="w-5 h-5 text-danger"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  ),
  info: (
    <svg
      className="w-5 h-5 text-accent"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <>
      <style>
        {`
          @keyframes toast-slide-in {
            from { transform: translateX(120%); opacity: 0; }
            to   { transform: translateX(0);    opacity: 1; }
          }
          .animate-toast-in {
            animation: toast-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          }
        `}
      </style>

      <div
        className="fixed top-[calc(env(safe-area-inset-top)+4rem)] md:top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.type === "error" ? "alert" : "status"}
            aria-live={toast.type === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className="pointer-events-auto flex w-[calc(100vw-2rem)] sm:w-auto sm:min-w-[320px] max-w-[calc(100vw-2rem)] sm:max-w-md overflow-hidden rounded-[14px] backdrop-blur-xl bg-elevated/90 border border-border-strong shadow-[0_20px_50px_-24px_rgba(0,0,0,0.5)] animate-toast-in"
          >
            <div
              className={`flex items-center justify-center w-12 flex-shrink-0 ${iconBg[toast.type]}`}
            >
              {icons[toast.type]}
            </div>

            <div className="flex-1 min-w-0 py-3 px-4 flex flex-col justify-center">
              {toast.title && (
                <h4
                  className={`text-[13px] font-semibold mb-1 ${titleColor[toast.type]}`}
                >
                  {toast.title}
                </h4>
              )}
              <p
                className={`text-[13px] font-medium text-ink whitespace-pre-line break-words ${toast.title ? "leading-relaxed" : ""}`}
              >
                {toast.message}
              </p>
            </div>

            <div className="flex items-start pt-3 pr-3">
              <button
                onClick={() => removeToast(toast.id)}
                className="text-subtle hover:text-ink transition-colors flex-shrink-0"
                aria-label="Close notification"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
