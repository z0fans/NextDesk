import { createContext, useState, useEffect, type ReactNode } from 'react';
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

function initialLanguage(): Language {
  try {
    const savedLang = localStorage.getItem('nextdesk-language') as Language | null;
    if (savedLang === 'zh-CN' || savedLang === 'en-US') return savedLang;
  } catch {
    // Fall back to the browser locale when storage is unavailable.
  }
  return navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function LanguageProvider({ children }: LanguageProviderProps) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    const initLanguage = async () => {
      const savedLang = localStorage.getItem('nextdesk-language') as Language | null;
      if (savedLang && (savedLang === 'en-US' || savedLang === 'zh-CN')) {
        setLanguageState(savedLang);
      } else {
        try {
          const systemLang = await api.getSystemLanguage();
          if (systemLang === 'zh-CN' || systemLang === 'en-US') {
            setLanguageState(systemLang as Language);
            localStorage.setItem('nextdesk-language', systemLang);
          }
        } catch {
          const browserLang = navigator.language;
          if (browserLang.startsWith('zh')) {
            setLanguageState('zh-CN');
          } else {
            setLanguageState('en-US');
          }
        }
      }
    };
    initLanguage();
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('nextdesk-language', lang);
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
