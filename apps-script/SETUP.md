# MUVE booking emails, spreadsheet & double-booking protection

This runs in the Google Apps Script project that the website already sends bookings to
(the `APPS_SCRIPT_URL` in `script.js`). Setup takes about 10 minutes.

**Do this before uploading the new website.** The new site expects the new script's replies.
If the site goes live first, customers will see "We couldn't process your request".

## 1. Paste in the code
1. Open https://script.google.com and open the project behind your booking URL.
   Sign in with the Google account that should send the emails. Ideally that's
   the account for fam@muvepro.com.
2. Replace everything in `Code.gs` with the contents of `apps-script/Code.gs` from this repo.
3. Add a file named `recaptcha.gs` (click **+ → Script**) and paste in `apps-script/recaptcha.gs`.
4. Click **Project Settings** (the gear icon) and set **Time zone** to *(GMT-08:00) Pacific Time – Los Angeles*.
5. Click **Save**.

## 2. Run setup once
1. In the function dropdown at the top, choose **setup**, then click **Run**.
2. Google will ask for permissions (Gmail send, Drive, Sheets, triggers). Click **Allow**.
   If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**.
   It's your own script, so this is safe.
3. That creates:
   - a **MUVE Bookings** folder in your Google Drive
   - this month's and next month's spreadsheet (for example "MUVE Bookings – October 2026")
   - a schedule that creates a new spreadsheet on the 1st of every month

## 3. Deploy the new version
**Deploy → Manage deployments → ✏️ edit** your existing web app. Set:
- **Version:** *New version*
- **Execute as:** *Me*
- **Who has access:** *Anyone*

Click **Deploy**. The URL stays the same, so the website doesn't need changing.

## 4. Test it
Choose **sendTestBooking** in the dropdown and click **Run**. You'll get two emails at
fam@muvepro.com: the customer version and the owner version, which has a
**Review & confirm** button. Click it, then click **Confirm**. The test booking
appears in this month's spreadsheet. Delete that row afterwards.

## How it works day to day
| When | What happens |
|---|---|
| Customer books on the website | The customer gets "We got your booking request" with their confirmation number. fam@muvepro.com gets the details and a **Review & confirm** button. |
| You click **Confirm** | The booking is added to the spreadsheet for the job's month, and the customer gets "Your booking is confirmed". |
| You click **Decline** | The customer is told you'll call to find another time. Nothing is added to the spreadsheet. |
| The 1st of each month | A new spreadsheet is created in the MUVE Bookings folder. |

**Double booking:** each date + time window (morning / midday / afternoon) takes **1 job**.
Requests waiting for your confirmation also hold their slot. Full slots show as
"fully booked" on the website and can't be submitted, and **Confirm** won't add a
second job to a slot that's already booked.
- **Two jobs per window** (for example, one per crew): change `JOBS_PER_SLOT: 1` to `2` in `Code.gs`, then deploy a new version.
- **To cancel a job and free its slot:** change its **Status** cell in the spreadsheet to `Cancelled`.
- **Unanswered requests** are cleared after 60 days.

## Customer reviews
1. **Add your Google review link.** In your Google Business Profile, click **Ask for reviews**
   (or **Get more reviews**) and copy the link. It looks like `https://g.page/r/XXXX/review`.
   Paste it into `GOOGLE_REVIEW_URL: ''` near the top of `Code.gs`.
2. After a job, set its **Status** to **Completed** using the dropdown in the spreadsheet.
3. Within the hour, the customer gets a "How did we do?" email with 5 stars and a Google review button.
4. When they submit a rating, fam@muvepro.com gets an email with the stars and comments.
   It's also saved in that month's **Reviews** tab.

Every customer sees the Google button, whatever their rating. Google doesn't allow sending
only happy customers to Google ("review gating").

Reviews posted *on Google* go to your Google Business Profile, not to this script. To get
emailed about those too, go to **Business Profile → ⋮ → Business Profile settings →
Notifications** and turn on **Customer reviews**.

**After updating the code:** run **setup** once more. It adds the hourly review check and
the Status dropdown. Then deploy a **New version** of the existing deployment.

## If customer emails bounce ("Message rejected")
The script sends through the fam@muvepro.com Gmail mailbox (`GmailApp`), so emails go out the
same way as ones you write yourself. If you update from an older version that used `MailApp`:
1. Paste in the new `Code.gs`, then run **setup** once and click **Allow**. This grants the new Gmail permission.
2. Deploy a **New version** of the existing deployment.
3. Put your own outside address (for example a personal Gmail) in `sendTestToOutsideEmail`,
   run it, and check that it arrives. In Admin console → **Reporting → Email Log Search** it should show **Delivered**.

**Email limits:** a regular Gmail account can send about 100 emails a day from a
script. A Google Workspace account can send about 1,500. Each booking uses 2 emails,
plus 1 when you confirm or decline.
