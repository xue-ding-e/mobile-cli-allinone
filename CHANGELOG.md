## [0.0.12](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.12) (2025-04-12)

* Server: If hitting an error with tunnel, forward proxy, wda, descriptive error and link to documentation will be returned
* iOS: go-ios path can be set in env GO_IOS_PATH
* iOS: Support go-ios that was built locally (no version)
* iOS: Return bundle display name for apps for better app launch
* iOS: Fixed finding element coordinates on retina displays 
* iOS: Saving temporary screenshots onto temporary directory (fixes [#19](https://github.com/mobile-next/mobile-mcp/issues/19))
* iOS: Find elements better by removing off-screen and hidden elements
* Android: Support for 'adb' under ANDROID_HOME
* Android: Find elements better using accessibility hints and class names

## [0.0.11](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.11) (2025-04-06)

* Server: Support submit after sending text (\n)
* Server: Added support for multiple devices at the same time
* iOS: Support for iOS physical devices using go-ios ([see wiki](https://github.com/mobile-next/mobile-mcp/wiki/Getting-Started-with-iOS-Physical-Device))
* iOS: Added support for icons, search fields, and switches when getting elements on screen
