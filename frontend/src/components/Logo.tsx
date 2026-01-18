import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
}

export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-6 w-6", className)}
    >
      <defs>
        {/* Background Verticals Gradient: Deep Blue to Blue */}
        <linearGradient id="grad-node" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e3a8a" /> {/* Blue 900 */}
          <stop offset="100%" stopColor="#2563eb" /> {/* Blue 600 */}
        </linearGradient>

        {/* Foreground Diagonal Gradient: Electric Blue to Cyan */}
        <linearGradient id="grad-beam" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" /> {/* Blue 500 */}
          <stop offset="40%" stopColor="#06b6d4" /> {/* Cyan 500 */}
          <stop offset="100%" stopColor="#22d3ee" /> {/* Cyan 400 */}
        </linearGradient>

        {/* Shadow for Depth */}
        <filter id="depth-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="8" />
          <feOffset dx="4" dy="8" result="offsetblur" />
          <feFlood floodColor="#000000" floodOpacity="0.3" />
          <feComposite in2="offsetblur" operator="in" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Subtle Inner Glow/Sheen */}
        <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.2" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g>
        {/* Left Node (Pill) */}
        <rect x="80" y="64" width="100" height="384" rx="50" fill="url(#grad-node)" />
        
        {/* Right Node (Pill) */}
        <rect x="332" y="64" width="100" height="384" rx="50" fill="url(#grad-node)" />

        {/* The Accelerator (Diagonal) */}
        <line
          x1="130"
          y1="114"
          x2="382"
          y2="398"
          stroke="url(#grad-beam)"
          strokeWidth="100"
          strokeLinecap="round"
          filter="url(#depth-shadow)"
        />
        
        {/* Sheen Overlay on Diagonal */}
        <line
          x1="130"
          y1="114"
          x2="382"
          y2="398"
          stroke="url(#sheen)"
          strokeWidth="100"
          strokeLinecap="round"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
    </svg>
  );
}
