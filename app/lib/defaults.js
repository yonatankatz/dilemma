'use strict';
// Seed content, used only when the data directory has no dilemmas/settings yet.
// Options are written in first-person future tense so they are gender-neutral in Hebrew.

const DEFAULT_SETTINGS = {
  voteSeconds: 20,
  breakdownDelaySeconds: 3,
  segments: [
    { id: 'age', label: 'גיל', options: ['מתחת ל-60', '60 ומעלה'] },
    { id: 'sector', label: 'מגזר', options: ['חרדי', 'דתי לאומי'] },
  ],
};

const SEED_DILEMMAS = [
  {
    text: 'נסעתם עם אבא, ושוטר עצר אותו על מהירות מופרזת. השוטר פונה אליכם ושואל באיזו מהירות הוא נסע.',
    option1: 'אגיד את האמת',
    option2: 'אחפה על אבא',
  },
  {
    text: 'הקופאית בסופר החזירה לכם בטעות 100 ₪ עודף במקום 10 ₪. שמתם לב רק כשהגעתם לרכב.',
    option1: 'אחזור להחזיר',
    option2: 'אמשיך בדרכי',
  },
  {
    text: 'חבר טוב השקיע שעות בארוחה בשבילכם, והיא ממש לא טעימה. הוא שואל איך היה.',
    option1: 'אגיד את האמת בעדינות',
    option2: 'אגיד שהיה מעולה',
  },
  {
    text: 'ראיתם חבר לכיתה מעתיק במבחן חשוב, שמשפיע על הציון של כולם.',
    option1: 'אספר למורה',
    option2: 'אשתוק',
  },
  {
    text: 'מצאתם ברחוב ארנק עם 500 ₪ במזומן, בלי שום פרט מזהה.',
    option1: 'אמסור למשטרה',
    option2: 'אשאיר לעצמי',
  },
  {
    text: 'אפשר לחזור 10 שנים אחורה בזמן, עם כל מה שאתם יודעים היום — אבל להתחיל משם הכול מחדש.',
    option1: 'אחזור אחורה',
    option2: 'אשאר בהווה',
  },
];

module.exports = { DEFAULT_SETTINGS, SEED_DILEMMAS };
