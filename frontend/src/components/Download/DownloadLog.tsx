import { useEffect, useRef } from "react";

interface DownloadLogProps {
  lines?: string[];
}

export default function DownloadLog({ lines = [] }: DownloadLogProps) {
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="space-y-2">
      <h3 className="section-title">Activity Log</h3>
      <pre ref={logRef} className="log min-h-[180px]">
        {lines.length > 0 ? lines.join("\n") : "Waiting for output..."}
      </pre>
    </div>
  );
}
