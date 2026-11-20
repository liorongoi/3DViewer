// Strings for Gaussian splat models and for making them from captures (docs/GAUSSIAN_SPLATS.md).
// Kept beside i18n.ts and merged into it; the same key-matching test covers both languages.

export const enSplatChecks = {
  splatUnreadable: { title: "{{file}} cannot be opened as Gaussian splats" },
  splatSpz: { title: "Gaussian splats, SPZ version {{version}}", detail: "{{count}} splats, colour detail (spherical harmonics) degree {{sh}}." },
  splatPly: { title: "Gaussian splats from a training program (PLY)", detail: "{{count}} splats, colour detail (spherical harmonics) degree {{sh}}." },
  splatOneModel: { title: "One splat model per upload: {{file}} is used", detail: "The other splat files are not opened." },
  splat_unchanged: { title: "Drawn from your file as it is", detail: "The SPZ data goes into the 3D Tiles view unchanged. Your file is kept as uploaded." },
  splat_spz3_to_spz2: { title: "Drawn as SPZ version 2", detail: "Positions, colours, opacity, sizes and colour detail are kept. Your file is kept as uploaded." },
  splat_ply_to_spz2: { title: "Compressed to SPZ for viewing", detail: "About 10 times smaller to draw. Your PLY is kept as uploaded and can be downloaded." },
  splat_retiled: { title: "Split into tiles for smooth viewing", detail: "Far views draw a lighter version, close views every splat. Your file is kept as uploaded." },
  splatRotationPrecision: { title: "Splat orientations are drawn with slightly less precision", detail: "SPZ version 3 stores them more finely than the viewer draws them. Your file keeps the full precision." },
  splatExtraProps: { title: "Extra PLY properties are kept in your file only" },
  splatSelfChecked: { title: "Every splat was read and checked", detail: "The official 3D Tiles validator does not know the Gaussian splat extensions yet, so HOLO's own SPZ and PLY reader checked the file in full." },
  splatTiled: { title: "Split into {{tiles}} tiles in {{levels}} levels", detail: "Far views draw a lighter sample, close views every splat." },
};

export const heSplatChecks: { [K in keyof typeof enSplatChecks]: { [P in keyof (typeof enSplatChecks)[K]]: string } } = {
  splatUnreadable: { title: "לא ניתן לפתוח את {{file}} כספלאטים גאוסיאניים" },
  splatSpz: { title: "ספלאטים גאוסיאניים, SPZ גרסה {{version}}", detail: "{{count}} ספלאטים, רמת פירוט צבע (הרמוניות כדוריות) {{sh}}." },
  splatPly: { title: "ספלאטים גאוסיאניים מתוכנת אימון (PLY)", detail: "{{count}} ספלאטים, רמת פירוט צבע (הרמוניות כדוריות) {{sh}}." },
  splatOneModel: { title: "מודל ספלאטים אחד בכל העלאה: נעשה שימוש ב-{{file}}", detail: "קובצי הספלאטים האחרים לא נפתחים." },
  splat_unchanged: { title: "מוצג מהקובץ שלך כפי שהוא", detail: "נתוני ה-SPZ נכנסים לתצוגת ה-3D Tiles ללא שינוי. הקובץ שלך נשמר כפי שהועלה." },
  splat_spz3_to_spz2: { title: "מוצג כ-SPZ גרסה 2", detail: "המיקומים, הצבעים, האטימות, הגדלים ופירוט הצבע נשמרים. הקובץ שלך נשמר כפי שהועלה." },
  splat_ply_to_spz2: { title: "נדחס ל-SPZ לצפייה", detail: "קטן בערך פי 10 להצגה. קובץ ה-PLY שלך נשמר כפי שהועלה וניתן להורדה." },
  splat_retiled: { title: "חולק לאריחים לצפייה חלקה", detail: "מבט מרחוק מציג גרסה קלה יותר, ומבט מקרוב את כל הספלאטים. הקובץ שלך נשמר כפי שהועלה." },
  splatRotationPrecision: { title: "כיווני הספלאטים מוצגים בדיוק מעט נמוך יותר", detail: "SPZ גרסה 3 שומר אותם בדיוק גבוה מזה שהמציג מציג. הקובץ שלך שומר על הדיוק המלא." },
  splatExtraProps: { title: "מאפייני PLY נוספים נשמרים רק בקובץ שלך" },
  splatSelfChecked: { title: "כל הספלאטים נקראו ונבדקו", detail: "הבודק הרשמי של 3D Tiles עדיין לא מכיר את הרחבות הספלאטים הגאוסיאניים, ולכן קורא ה-SPZ וה-PLY של הולו בדק את הקובץ במלואו." },
  splatTiled: { title: "חולק ל-{{tiles}} אריחים ב-{{levels}} רמות", detail: "מבט מרחוק מציג מדגם קל יותר, ומבט מקרוב את כל הספלאטים." },
};
