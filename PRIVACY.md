# Privacy

ChatGPT UI State Inspector is designed for local, developer-controlled inspection.

## Collected locally

- Trusted click timing, pointer location, and structural target descriptors
- Selected ARIA and `data-*` state attributes
- Candidate locators and limited control labels
- DOM child-list and selected attribute changes
- Baseline, related, and final structural snapshots

## Deliberately excluded

- Input and textarea values
- Contenteditable text
- Chat message bodies
- Conversation-link titles in navigation
- Full page HTML
- Cookies, authentication tokens, headers, or network traffic
- Long free text and strings resembling email addresses, URLs, or telephone numbers

## Processing and retention

All processing occurs inside the installed extension. The extension makes no network requests and contains no telemetry. Sessions remain in `chrome.storage.local` until the user deletes the session or removes the extension. Export files are created locally only when the user clicks **파일 저장**.
