import CoreMediaIO
import Foundation

let source = LumenProvider()
CMIOExtensionProvider.startService(provider: source.provider)
CFRunLoopRun()
