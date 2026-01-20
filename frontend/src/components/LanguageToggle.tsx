import { useTranslation } from "@/i18n/useTranslation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LanguageToggle() {
  const { language, setLanguage } = useTranslation();

  const toggleLanguage = () => {
    setLanguage(language === "en-US" ? "zh-CN" : "en-US");
  };

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggleLanguage}
      className={cn(
        "rounded-full h-10 w-10 relative overflow-hidden transition-colors duration-300",
        "border border-zinc-200 dark:border-zinc-800",
        "bg-white dark:bg-zinc-900",
        "hover:bg-zinc-100 dark:hover:bg-zinc-800",
        "hover:border-zinc-300 dark:hover:border-zinc-700"
      )}
      title={language === "en-US" ? "Switch to Chinese" : "Switch to English"}
    >
      <span
        className={cn(
          "absolute transition-all duration-500 ease-in-out font-bold text-sm text-foreground",
          language === "en-US" ? "opacity-100 scale-100 rotate-0" : "opacity-0 scale-0 -rotate-90"
        )}
      >
        EN
      </span>
      <span
        className={cn(
          "absolute transition-all duration-500 ease-in-out font-bold text-sm text-foreground",
          language === "zh-CN" ? "opacity-100 scale-100 rotate-0" : "opacity-0 scale-0 rotate-90"
        )}
      >
        中
      </span>
      <span className="sr-only">Toggle language</span>
    </Button>
  );
}
