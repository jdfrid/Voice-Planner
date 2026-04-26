# Voice Planner

מערכת פשוטה לשמירת פגישות ומשימות מהקלטה:

- פקודה שמתחילה ב-`זימון` או `זימן` נשמרת ב-Google Calendar.
- פקודה שמתחילה ב-`משימה` נשמרת ב-Google Tasks.
- התמלול והבנת התאריך/שעה/מיקום נעשים בעזרת OpenAI.
- חיבור Google נעשה פעם אחת עם OAuth, וה-token נשמר בשרת תחת `DATA_DIR`.

## Local Run

```bash
npm install
npm run dev
```

פתח:

```text
http://localhost:3001
```

צור קובץ `.env`:

```env
OPENAI_API_KEY=your-openai-key
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3001/api/google/callback
VOICE_PLANNER_ACCESS_KEY=
DATA_DIR=./data
```

ב-Google Cloud Console צריך ליצור OAuth Client מסוג Web Application ולהוסיף:

```text
http://localhost:3001/api/google/callback
```

## Render Deploy

הריפו כולל `render.yaml`, לכן אפשר ליצור Blueprint ב-Render מהריפו:

```text
https://github.com/jdfrid/Voice-Planner
```

הגדר ב-Render:

```env
OPENAI_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://YOUR-RENDER-DOMAIN/api/google/callback
VOICE_PLANNER_ACCESS_KEY=optional-password
DATA_DIR=/var/data
```

ב-Google Cloud Console הוסף Authorized redirect URI:

```text
https://YOUR-RENDER-DOMAIN/api/google/callback
```

אם מוסיפים Persistent Disk ב-Render, מומלץ mount path:

```text
/var/data
```

ואז `DATA_DIR=/var/data`, כדי שהחיבור ל-Google יישמר גם אחרי deploy/restart.

## Examples

```text
זימון פגישת עבודה ביום שלישי ב-10 בבוקר במשרד
משימה להתקשר לרואה חשבון מחר בשעה 12
```
