import type { core as TrCore } from "../tr/core";

/** Paket D anahtarlarının İngilizcesi (TAM: her Türkçe anahtarın karşılığı olmalı; tür bunu zorlar). */
export const core = {
  "settings.nav.appearance": "Appearance & language",
  "settings.appearance.title": "Appearance & language",
  "settings.appearance.desc":
    "Choose the language of the screens and the colour theme. Changes apply immediately and are remembered on this computer.",
  "settings.language": "Interface language",
  "settings.language.hint":
    "Changes only the app's screens. The language of the emails you send is chosen in each template.",
  "settings.language.changed": "Interface language changed.",
  "uiLang.tr": "Türkçe",
  "uiLang.en": "English",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.hint": '"System" follows your computer\'s light/dark setting.',
  "settings.theme.changed": "Theme changed.",
  "settings.desktop.title": "Desktop app",
  "settings.openAtLogin.label": "Start when the computer starts",
  "settings.openAtLogin.hint":
    "Scheduled scans only run while the app is open. If you turn this on, the app starts by itself when you sign in to your computer.",
  "settings.notificationsOs.label": "Desktop notifications",
  "settings.notificationsOs.hint":
    "While the app is open, shows newly found and newly opened businesses, skipped scans and unsubscribe-link warnings as computer notifications. If you turn this off, notifications only appear in the bell inside the app.",
  "settings.desktop.browserOnly":
    "These two settings only appear in the desktop app; in a browser, notifications collect in the bell.",

  "settings.mapId.err.email":
    'This looks like an email address. The Map ID is the short code shown on the "Map Management" page of the Google Cloud Console.',
  "settings.mapId.err.too_long": "The Map ID can be at most 64 characters long.",
  "settings.mapId.err.invalid":
    "The Map ID may only contain letters, digits, underscores (_) and hyphens (-); no spaces, dots or slashes.",

  "bell.open": "Open notifications",
  "bell.unreadCount": "{n} unread notifications",
  "bell.unavailable": "Notifications are not available in this version yet.",
  "bell.loadError": "Notifications could not be loaded. Try again in a moment.",
  "bell.unread": "Unread",
  "bell.newToast": "New notification: {title}",

  "help.novelty":
    "The novelty score shows how likely it is that the business opened recently. It is a hint calculated from Google data, not proof.",
  "help.noveltyLabels":
    "Purple: opening soon. Green: very likely new. Yellow: possibly new. Grey: weak signs of being new.",
  "help.noveltyThresholds":
    'If the score is above these thresholds, the business is labelled "High" or "Likely". Lower thresholds give more but less certain results.',
  "help.budget":
    "The most that can be spent on Google searches this month. Scans stop by themselves at the limit; the exact amount is on your Google bill.",
  "help.mapId":
    "A code that sets how the Google map looks (for example a dark style). Leave it empty to use Google's default map.",
  "help.leadStatus":
    "The stage of your relationship with the business: new, email found, sent, replied and so on. It updates automatically with sends and replies.",
  "help.dailyCap":
    "The most emails this campaign sends in one day. A low number protects your email address's reputation and lowers the risk of landing in spam.",
  "help.sendGap":
    "How long to wait between two emails. Random gaps make sending look natural, as if done by hand.",
  "help.sendWindow":
    "The days and hours when emails may be sent. Times are in the recipient's local time.",
  "help.preflight":
    "A check before the campaign starts: it shows problems in advance, such as an unconnected mailbox, an incomplete template or blocked recipients.",
  "help.sequenceStatus":
    "Each recipient's status in the campaign: queued, sent, replied, stopped. Recipients who reply get no follow-up emails.",
  "help.policyMode":
    "The sending rule per country. Allowed: sent to suitable addresses. Generic address only: only to company addresses such as info@. Blocked: never sent to this country.",
  "help.suppression":
    "No campaign ever emails addresses or domains on the suppression list. People who unsubscribe are added here automatically.",
  "help.erasure":
    "An erasure request permanently deletes a person's data and adds their address to the suppression list. It cannot be undone.",
  "help.audit":
    "A record of important actions in the app: settings changes, sending decisions, erasure requests. Entries cannot be changed.",
  "help.dns":
    "SPF, DKIM and DMARC are records that prove your domain's emails really come from you. For Gmail addresses, Google manages them.",
  "help.bounceRate":
    "The share of emails that could not be delivered. If it rises, sending stops automatically to protect your sending reputation.",

  "sup.empty.none.title": "The suppression list is empty",
  "sup.empty.none.body":
    "Addresses and domains added here never receive email. People who unsubscribe and erasure requests are added here automatically.",
  "sup.empty.clear": "Clear filters",
  "audit.empty.body":
    "Settings changes, sending decisions and erasure requests are listed here as they happen.",
  "erasure.history.empty.body":
    "When someone asks for their data to be deleted, record the request above; completed requests appear here.",
  "templates.empty.none.title": "No templates yet",
  "templates.empty.none.body":
    "A template is the subject and text of the email a campaign sends. Create your first template.",
  "templates.empty.clear": "Clear filters",

  "apiError.generic":
    "The action could not be completed. Try again; if it keeps happening, close and reopen the app.",
  "apiError.HTTP": "The request failed ({status}).",
  "apiError.NETWORK":
    "The app's local server could not be reached. Wait a few seconds and try again.",
  "apiError.BAD_REQUEST": "The request was not accepted. Check the information you entered.",
  "apiError.VALIDATION":
    "Something is wrong with the information entered. Check the fields and try again.",
  "apiError.BAD_JSON": "The information could not be sent. Refresh the page and try again.",
  "apiError.INVALID_ID": "Invalid record number. Refresh the page and try again.",
  "apiError.UNAUTHORIZED": "You are not authorised to do this.",
  "apiError.FORBIDDEN": "This action is not allowed.",
  "apiError.NOT_FOUND": "Record not found. It may have been deleted; refresh the page.",
  "apiError.CONFLICT":
    "This action conflicts with the current state. Refresh the page and try again.",
  "apiError.RATE_LIMITED": "Too many attempts. Wait a moment and try again.",
  "apiError.UPSTREAM": "An external service sent an unexpected response. Try again in a moment.",
  "apiError.UNAVAILABLE": "The service is temporarily unavailable. Try again in a moment.",
  "apiError.INTERNAL":
    "An unexpected error occurred. Try again; if it keeps happening, close and reopen the app.",
  "apiError.DB_BUSY": "The database is busy right now. Try again in a few seconds.",
  "apiError.DB_NOT_READY": "The database is being prepared. Try again in a few seconds.",
  "apiError.SETUP_REQUIRED": "Finish the setup wizard first.",
  "apiError.PLACES_KEY_MISSING": "No Google Places API key is set. Add one in Settings.",
  "apiError.BUDGET_BLOCKED":
    "The monthly budget limit has been reached. Raise the budget in Settings.",
  "apiError.NEEDS_ACK":
    "The estimated cost may exceed your remaining budget. The scan stops by itself when the budget runs out. Confirm to start anyway.",
  "apiError.COUNTRY_NOT_TARGETED":
    "This region's country is not one of your target markets. Add it under Settings > Target markets.",
  "apiError.ACTIVE_SCAN": "Another scan for the same region is running. Wait for it to finish.",
  "apiError.PLAN_INVALID": "The scan area is not suitable. Choose a smaller area.",
  "apiError.MAP_ID_INVALID":
    "Invalid Map ID. Use only letters, digits, '_' and '-'; it cannot be an email address.",
  "apiError.PLACES_AUTH":
    "The Google API key is invalid or does not allow this request. Check the key.",
  "apiError.PLACES_BILLING": "Billing is turned off in the Google Cloud project.",
  "apiError.PLACES_DISABLED": "'Places API (New)' is not enabled in this project.",
  "apiError.PLACES_QUOTA":
    "The Google quota limit was reached. You can continue when the quota resets.",
  "apiError.PLACES_RATE": "Google temporarily slowed down requests. Continue in a moment.",
  "apiError.PLACES_INVALID": "Google rejected the request.",
  "apiError.PLACES_NETWORK": "Google could not be reached. Check your internet connection.",
  "apiError.PLACES_SERVER": "Google returned a temporary server error. Try again in a moment.",
  "apiError.PLACES_UNKNOWN": "An unexpected response came from Google.",
  "apiError.INVALID_INPUT": "Something is wrong with the information entered. Check the fields.",
  "apiError.INVALID_EMAIL": "Enter a valid email address.",
  "apiError.DUPLICATE": "This record already exists.",
  "apiError.LIVE_LOCKED": "This setting cannot be changed while live sending is on.",
  "apiError.UNCONFIRMED": "Confirm the action to continue.",
  "apiError.CONFIRMATION_REQUIRED": "Confirm the action to continue.",
  "apiError.IN_USE": "This record is in use and cannot be changed.",
  "apiError.BUILT_IN": "Built-in records cannot be changed. Make a copy first.",
  "apiError.ARCHIVED": "An archived record cannot be changed.",

  "placeType.cafe": "Café",
  "placeType.coffee_shop": "Coffee shop",
  "placeType.tea_house": "Tea house",
  "placeType.pub": "Pub",
  "placeType.bar": "Bar",
  "placeType.wine_bar": "Wine bar",
  "placeType.night_club": "Night club",
  "placeType.restaurant": "Restaurant",
  "placeType.fast_food_restaurant": "Fast food",
  "placeType.meal_takeaway": "Takeaway",
  "placeType.meal_delivery": "Delivery",
  "placeType.bakery": "Bakery",
  "placeType.dessert_shop": "Dessert shop",
  "placeType.ice_cream_shop": "Ice cream shop",
  "placeType.hotel": "Hotel",
  "placeType.hostel": "Hostel",
  "placeType.bed_and_breakfast": "Bed & breakfast",
  "placeType.catering_service": "Catering",
  "placeType.event_venue": "Event venue",
  "placeType.wedding_venue": "Wedding venue",
  "placeType.hospital": "Hospital",
  "placeType.dental_clinic": "Dental clinic",
  "placeType.physiotherapist": "Physiotherapy",
  "placeType.child_care_agency": "Childcare",
  "placeType.preschool": "Preschool",
  "placeType.school": "School",
  "placeType.university": "University",
  "placeType.corporate_office": "Office",
  "placeType.coworking_space": "Coworking",
  "placeType.gym": "Gym",
  "placeType.beauty_salon": "Beauty salon",
  "placeType.hair_salon": "Hair salon",
  "placeType.spa": "Spa",
  "placeType.gas_station": "Petrol station",
  "placeType.convenience_store": "Convenience store",
  "placeType.cafeteria": "Cafeteria",

  "category.cafe": "Café / coffee shop",
  "category.pub": "Bar / pub",
  "category.restaurant": "Restaurant / takeaway",
  "category.bakery": "Bakery / patisserie / desserts",
  "category.hotel": "Hotel / hostel / guesthouse",
  "category.catering": "Catering / event venue",
  "category.health": "Hospital / clinic / dentist",
  "category.education": "Nursery / school / university",
  "category.office": "Office / coworking space",
  "category.wellness": "Gym / beauty / spa",
  "category.convenience": "Petrol station shop / kiosk / canteen",

  "noveltySignal.future_opening":
    'Google reports this business as "opening soon". This does not mean it is looking for suppliers.',
  "noveltySignal.opened_transition":
    'Was "opening soon" and is now seen as operational (within the last {days} days).',
  "noveltySignal.new_in_snapshot":
    "Not in the previous scan, found in the latest one (within the last {days} days). This does not prove the real opening date.",
  "noveltySignal.reviews_very_few": "Very few reviews. On its own this does not show it is new.",
  "noveltySignal.reviews_few": "Few reviews. A low-confidence signal.",

  "electron.menu.view": "View",
  "electron.menu.help": "Help",
  "electron.menu.openData": "Open data folder",
  "electron.menu.openLogs": "Open log folder",
  "electron.unsaved.title": "Unsaved changes",
  "electron.unsaved.message": "Discard unsaved changes?",
  "electron.unsaved.detail":
    "This page has changes you have not saved. If you continue, these changes will be lost.",
  "electron.unsaved.discard": "Discard changes",
  "electron.unsaved.keep": "Keep editing",
  "electron.quitScan.title": "Scan in progress",
  "electron.quitScan.message": "A scan is in progress.",
  "electron.quitScan.detail":
    "If you close the app, the scan is paused. You can resume it where it left off when you open the app again; paid calls never continue without your approval.",
  "electron.quitScan.quit": "Close and pause",
  "electron.quitScan.cancel": "Cancel",
  "electron.keystore.title": "Secure storage unavailable",
  "electron.keystore.body":
    "The operating system's key store (Keychain / Credential Manager) is not available in this session. The app is closing because your API keys cannot be stored securely.",
  "electron.startError.title": "Universal Mail could not start",
  "electron.startError.logDir": "Log folder: {dir}",
  "electron.deliveryAlert.title": "Unsubscribe link warning",
  "electron.deliveryAlert.body":
    "Unsubscribe requests may not be processed. See the Compliance page for details.",
} as const satisfies { readonly [K in keyof typeof TrCore]: string };
