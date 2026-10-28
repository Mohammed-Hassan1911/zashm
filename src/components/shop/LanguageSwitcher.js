import React, { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { getLanguage, setLanguage, applyDocumentLanguage } from '../../lib/i18n';

export default function LanguageSwitcher({ isMobile = false }) {
  const { language, setLanguage: setStoreLanguage } = useStore();
  const [currentLang, setCurrentLang] = useState(language || getLanguage());

  useEffect(() => {
    const lang = getLanguage();
    setCurrentLang(lang);
    applyDocumentLanguage(lang);
    if (setStoreLanguage) setStoreLanguage(lang);
  }, []);

  const toggleLanguage = () => {
    const newLang = currentLang === 'en' ? 'ar' : 'en';
    setCurrentLang(newLang);
    setLanguage(newLang);
    if (setStoreLanguage) setStoreLanguage(newLang);
    // Trigger re-render across app
    window.dispatchEvent(new Event('languagechange'));
  };

  return (
    <button
      onClick={toggleLanguage}
      aria-label="Change language"
      style={{
        background: 'none',
        border: '1px solid var(--border)',
        color: 'var(--gold)',
        cursor: 'pointer',
        padding: isMobile ? '6px 10px' : '6px 12px',
        fontSize: isMobile ? 10 : 11,
        fontWeight: 600,
        letterSpacing: 1,
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        transition: 'all 0.2s ease'
      }}
    >
      {currentLang === 'en' ? 'العربية' : 'English'}
    </button>
  );
}
