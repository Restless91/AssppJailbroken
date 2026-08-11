import { ReactNode, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useSearch } from "../../hooks/useSearch";

interface PageContainerProps {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}

export default function PageContainer({
  title,
  children,
  action,
}: PageContainerProps) {
  const location = useLocation();
  const clearSearch = useSearch((state) => state.clear);

  // Clear stale search state when leaving the search workflow.
  useEffect(() => {
    if (!location.pathname.startsWith("/search")) {
      clearSearch();
    }
  }, [location.pathname, clearSearch]);

  return (
    <div className="flex-1 overflow-y-auto bg-bg pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-6 anim-in">
        {(title || action) && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            {title && (
              <h1 className="page-title">
                {title}
              </h1>
            )}
            {action && <div>{action}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
