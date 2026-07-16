import { Moon, Sun, Monitor } from "lucide-react";
import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ThemeMode = "light" | "dark" | "auto";

/** Determine effective theme based on local time (7:00-19:00 = light) */
function getAutoTheme(): "light" | "dark" {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 19 ? "light" : "dark";
}

/** Apply the effective theme to the DOM */
function applyTheme(effective: "light" | "dark") {
  document.documentElement.classList.toggle("dark", effective === "dark");
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("nextdesk-theme");
    return saved === "light" || saved === "dark" || saved === "auto"
      ? saved
      : "auto";
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derive the effective (visual) theme from mode
  const effectiveTheme = mode === "auto" ? getAutoTheme() : mode;

  // Auto-mode timer: check every 60s if theme should flip
  const updateAutoTheme = useCallback(() => {
    if (mode !== "auto") return;
    applyTheme(getAutoTheme());
  }, [mode]);

  useEffect(() => {
    // Apply theme immediately when mode changes
    applyTheme(mode === "auto" ? getAutoTheme() : mode);

    // Set up or tear down the interval
    if (mode === "auto") {
      intervalRef.current = setInterval(updateAutoTheme, 60_000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [mode, updateAutoTheme]);

  // Cycle: light → dark → auto → light ...
  const cycleTheme = () => {
    const next: ThemeMode =
      mode === "light" ? "dark" : mode === "dark" ? "auto" : "light";
    setMode(next);
    localStorage.setItem("nextdesk-theme", next);
  };

  // Tooltip text
  const titleMap: Record<ThemeMode, string> = {
    light: "Light mode (click for dark)",
    dark: "Dark mode (click for auto)",
    auto: `Auto mode (${effectiveTheme}) (click for light)`,
  };

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={cycleTheme}
      className={cn(
        "rounded-full h-10 w-10 relative overflow-hidden transition-colors duration-300",
        "border border-zinc-200 dark:border-zinc-800",
        "bg-white dark:bg-zinc-900",
        "hover:bg-zinc-100 dark:hover:bg-zinc-800",
        "hover:border-zinc-300 dark:hover:border-zinc-700"
      )}
      title={titleMap[mode]}
    >
      {/* Sun icon — visible in light mode */}
      <Sun
        className={cn(
          "h-5 w-5 absolute transition-all duration-500 ease-in-out",
          mode === "light"
            ? "rotate-0 scale-100 opacity-100 text-orange-500"
            : "rotate-90 scale-0 opacity-0"
        )}
      />
      {/* Moon icon — visible in dark mode */}
      <Moon
        className={cn(
          "h-5 w-5 absolute transition-all duration-500 ease-in-out",
          mode === "dark"
            ? "rotate-0 scale-100 opacity-100 text-blue-400"
            : "-rotate-90 scale-0 opacity-0"
        )}
      />
      {/* Monitor icon — visible in auto mode */}
      <Monitor
        className={cn(
          "h-5 w-5 absolute transition-all duration-500 ease-in-out",
          mode === "auto"
            ? "rotate-0 scale-100 opacity-100 text-emerald-500"
            : "rotate-90 scale-0 opacity-0"
        )}
      />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
