import { createContext, useState, useEffect, useRef, type ReactNode } from 'react';
import { translations, type Language, type TranslationKey } from './translations';
import { api } from '../api';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

interface LanguageProviderProps {
  children: ReactNode;
}

function savedLanguage(): Language | null {
  try {
    const savedLang = localStorage.getItem('nextdesk-language');
    if (savedLang === 'zh-CN' || savedLang === 'en-US') return savedLang;
  } catch {
    // Storage is optional; language selection must remain usable without it.
  }
  return null;
}

function saveLanguage(language: Language) {
  try {
    localStorage.setItem('nextdesk-language', language);
  } catch (error) {
    console.warn('[i18n] failed to save language', error);
  }
}

export function LanguageProvider({ children }: LanguageProviderProps) {
  const [language, setLanguageState] = useState<Language>(() =>
    savedLanguage() ?? (navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US')
  );
  const userSelectedLanguage = useRef(false);

  useEffect(() => {
    if (savedLanguage()) return;
    let active = true;
    void api.getSystemLanguage().then((systemLang) => {
      if (!active || userSelectedLanguage.current) return;
      if (systemLang === 'zh-CN' || systemLang === 'en-US') {
        setLanguageState(systemLang);
        saveLanguage(systemLang);
      }
    }).catch(() => {
      // Keep the initial browser fallback or the user's newer selection.
    });
    return () => {
      active = false;
    };
  }, []);

  const setLanguage = (lang: Language) => {
    userSelectedLanguage.current = true;
    setLanguageState(lang);
    saveLanguage(lang);
  };

  const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
    const translation = translations[language][key] || translations['en-US'][key] || key;
    
    if (params) {
      let result = translation;
      Object.entries(params).forEach(([paramKey, value]) => {
        result = result.replace(`{${paramKey}}`, String(value));
      });
      return result;
    }
    
    return translation;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}
