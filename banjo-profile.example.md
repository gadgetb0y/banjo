# Copy to banjo-profile.md (git-ignored) and set PROMPT_PROFILE_FILE=./banjo-profile.md in .env.
#
# Everything in this file goes into the prompt of every outbound call, in your own words. Write it the
# way you'd brief a human assistant before they pick up the phone. Keep it short: 4,000 characters max,
# and every line costs a little on every call.
#
# What you CAN'T change from here: Banjo always says it's an AI if asked, only books after a clear
# yes, and treats every time as CALENDAR_TIMEZONE local. The prompt tells the model those rules win
# over anything below. Notes you pass for a single call (place_call's constraints.notes) win over
# this file.
#
# Banjo shares a fact only when it matters to the call or it's asked. Even so, don't put anything
# here you wouldn't want said to a stranger on the phone.

## About me
- My name is Sam Rivera. Call-backs go to 555-0100.
- I work from home; mornings before 10 are hard, and I'd rather not book anything on Mondays.

## Pets and people Banjo might book for
- Pepper: 8-year-old beagle, about 25 lb. Fine with clippers, hates nail trims — ask for a gentle groomer.
- My daughter Ava (9) sees Dr. Chen for checkups; she's allergic to penicillin.

## How calls should sound
- Friendly and brief. Skip the small talk unless they start it.
- If a price is more than 20% above what they quoted last time, don't book — tell me instead.
