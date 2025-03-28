## Mobile Next - MCP server for Appium Mobile Automation - Empowering Next Generation of Mobile Automation

This is a [Model Context Protocol (MCP) server](https://github.com/modelcontextprotocol) that provides mobile automation capabilities using [Appium](https://github.com/appium). 
This server allows LLMs to interact with native iOS and Android applications through structured accessibility snapshots or coordinate-based taps based on screenshots. 
By operating on accessibility data, it eliminates the need for traditional, visually-tuned (pixel-based) models—though a Vision Mode is also supported for coordinate-based interactions when needed.

<p align="center">
    <a href="https://github.com/mobile-next/">
        <img alt="mobile-mcp" src="https://github.com/mobile-next/appium-mcp/images/mobile-mcp.png" width="600">
    </a>
</p>

### Main use cases - how we help to automate at scale

- Native app automation (iOS and Android) for testing or data-entry scenarios. 
- Scripted flows and form interactions without manually controlling simulators/emulators or physical devices (iPhone, Samsung, Google Pixel etc)
- Automating multi-step user journeys driven by an LLM
- General-purpose mobile application interaction for agent-based frameworks
- Enables agent-to-agent communication for mobile automation usecases, data extraction

### Main Features

- **Fast and lightweight**: Uses native accessibility trees for most interactions, or screenshot based coordinates where a11y labels are not available. 
- **LLM-friendly**: No computer vision model required in Accessibility (Snapshot) Mode—coordinates are only needed when explicitly using Vision Mode.
- **Deterministic tool application**: Reduces ambiguity found in purely screenshot-based approaches by relying on structured data whenever possible.
- **Extract structured data**: Enables you to extract structred data from anything visible on screen. 

### Example config for initilisation

```js
{
  "mcpServers": {
    "mobile-next": {
      "command": "npx",
      "args": [
        "@mobile-next/appium-mcp@latest"
      ]
    }
  }
}
```

### Simulators, Emulators, and Physical Devices

When launched, Appium MCP can connect to:
	•	iOS Simulators on macOS/Linux
	•	Android Emulators on Linux/Windows/macOS
	•	Physical iOS or Android devices (requires proper platform tools and drivers)

Make sure you have your mobile platform SDKs (Xcode, Android SDK) installed and configured properly before running Mobile Next Appium MCP.


### Running in “headless” mode (no physical device)

When you do not have an actual phone connected, you can run Mobile Next Appium MCP with an emulator or simulator in the background.

For example, on Android:
	1.	Start an emulator (avdmanager / emulator command).
	2.	Run Appium MCP with the desired flags (see below for adding --snapshot or --vision mode).

On iOS, you’ll need Xcode and to run the Simulator before using Appium MCP with that simulator instance.


### Snapshot Mode Tools

These tools use accessibility-based element references on iOS or Android. By relying on the accessibility/automation IDs, you avoid the ambiguity of coordinate-based approaches.

## mobile_install_app
- **Description:** Installs an app onto the device/emulator
- **Parameters:**
  - `appPath` (string): Path or URL to the app file (e.g., .apk for Android, .ipa/.app for iOS)

## mobile_launch_app
- **Description:** Launches the specified app on the device/emulator
- **Parameters:**
  - `bundleId` (string): The application’s unique bundle/package identifier like: com.google.android.keep	 or com.apple.mobilenotes )

## mobile_terminate_app
- **Description:** Terminates a running application
- **Parameters:**
  - `bundleId` (string): The application’s bundle/package identifier

## mobile_element_tap
- **Description:** Taps on a UI element identified by accessibility locator
- **Parameters:**
  - `element` (string): Human-readable element description (e.g., “Login button”)
  - `ref` (string): Accessibility/automation ID or reference from a snapshot

## mobile_element_send_keys
- **Description:** Types text into a UI element (e.g., TextField)
- **Parameters:**
  - `element` (string): Human-readable element description
  - `ref` (string): Accessibility/automation ID of the element
  - `text` (string): Text to type
  - `submit` (boolean): Whether to press Enter/Return after typing

## mobile_element_swipe
- **Description:** Performs a swipe gesture from one UI element to another
- **Parameters:**
  - `startElement` (string): Human-readable description of the start element
  - `startRef` (string): Accessibility/automation ID of the start element
  - `endElement` (string): Human-readable description of the end element
  - `endRef` (string): Accessibility/automation ID of the end element

## mobile_press_key
- **Description:** Presses hardware keys or triggers special events (e.g., back button on Android)
- **Parameters:**
  - `key` (string): Key identifier (e.g., HOME, BACK, VOLUME_UP, etc.)

## mobile_take_screenshot
- **Description:** Captures a screenshot of the current device screen
- **Parameters:**
  - `raw` (boolean): Return a lossless image if true; otherwise, compressed by default

## mobile_get_source
- **Description:** Fetches the current device UI structure (accessibility snapshot) (xml format)
- **Parameters:** None

## mobile_wait
- **Description:** Waits for a specified time
- **Parameters:**
  - `time` (number): Time to wait in seconds (capped at 10 seconds)

## mobile_close_session
- **Description:** Closes the current Appium session
- **Parameters:** None


# Vision Mode Tools

These tools rely on screenshots and screen coordinates for automation. Use this approach if accessibility references are unavailable or insufficient.

## mobile_install_app
- **Description:** Installs an app onto the device/emulator
- **Parameters:**
  - `appPath` (string): Path or URL to the app file

## mobile_launch_app
- **Description:** Launches the specified app on the device/emulator
- **Parameters:**
  - `bundleId` (string): The application’s unique bundle/package identifier

## mobile_terminate_app
- **Description:** Terminates a running application
- **Parameters:**
  - `bundleId` (string): The application’s bundle/package identifier

## mobile_take_screenshot
- **Description:** Captures a screenshot of the current device screen
- **Parameters:** None

## mobile_tap
- **Description:** Taps on specified screen coordinates
- **Parameters:**
  - `x` (number): X-coordinate
  - `y` (number): Y-coordinate

## mobile_swipe
- **Description:** Performs a swipe gesture between two sets of screen coordinates
- **Parameters:**
  - `startX` (number): Start X-coordinate
  - `startY` (number): Start Y-coordinate
  - `endX` (number): End X-coordinate
  - `endY` (number): End Y-coordinate

## mobile_type
- **Description:** Types text at the current input focus (if supported)
- **Parameters:**
  - `text` (string): Text to type
  - `submit` (boolean): Whether to press Enter/Return after typing

## mobile_press_key
- **Description:** Presses hardware keys (e.g., Android Back button, Home button)
- **Parameters:**
  - `key` (string): Key identifier (e.g., HOME, BACK, VOLUME_UP, etc.)

## mobile_wait
- **Description:** Waits for a specified time in seconds
- **Parameters:**
  - `time` (number): Time to wait in seconds (capped at 10 seconds)

## mobile_close_session
- **Description:** Closes the current Appium session
- **Parameters:** None
