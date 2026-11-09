import i18n, { type FormatterModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { en, he, isolateValue } from "@viewer/shared";
import { readPref } from "./state/prefs";

/** Values in Hebrew sentences keep their own direction (see isolateValue). */
const isolating: FormatterModule = {
  type: "formatter",
  init() {},
  add() {},
  addCached() {},
  // Values that are not text (objects for <Trans>) go through unchanged.
  format: (value, _format, lng) => isolateValue(value, lng) as string,
};

const lang = readPref("lang", "en");
void i18n.use(initReactI18next).use(isolating).init({
  resources: { en: { translation: en }, he: { translation: he } },
  lng: lang,
  fallbackLng: "en",
  interpolation: { escapeValue: false, alwaysFormat: true },
});

export function applyLanguage(lng: "en" | "he"): void {
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
  document.documentElement.dir = lng === "he" ? "rtl" : "ltr";
}
applyLanguage(lang as "en" | "he");
export default i18n;
