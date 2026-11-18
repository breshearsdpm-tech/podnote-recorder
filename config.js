// PodNote iPad recorder settings.
// After you create a Google OAuth "Web application" client (see README, step 3),
// paste its Client ID below. Leave it empty to use the iPad Share sheet instead
// ("Save to Files" -> Google Drive -> PodNote-Inbox).
window.PODNOTE_CONFIG = {
  googleClientId: "952242031732-5e2ug1ughgh5dkvv0h2nfk1lurp4upfn.apps.googleusercontent.com",
  driveFolderName: "PodNote-Inbox",
  visitTypes: [
    "Follow-up",
    "New patient",
    "Post-op",
    "Routine foot care",
    "Diabetic foot exam",
    "Wound care",
    "Injection",
    "Orthotics / DME",
    "Other"
  ]
};
