import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en, he } from "@viewer/shared";
import { readPref } from "./state/prefs";

const lang = readPref("lang", "en");
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, he: { translation: he } },
  lng: lang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function applyLanguage(lng: "en" | "he"): void {
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
  document.documentElement.dir = lng === "he" ? "rtl" : "ltr";
}
applyLanguage(lang as "en" | "he");
export default i18n;
