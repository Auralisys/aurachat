import Flutter
import UIKit
import UserNotifications
import FirebaseCore
import FirebaseMessaging

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let result = super.application(application, didFinishLaunchingWithOptions: launchOptions)
    // flutter_local_notifications riceve le notifiche tramite l'app delegate.
    UNUserNotificationCenter.current().delegate = self as? UNUserNotificationCenterDelegate
    return result
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    // Same explicit APNs mapping used by the working Nuifit native runner.
    if FirebaseApp.app() != nil {
      Messaging.messaging().apnsToken = deviceToken
    }
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }
}
