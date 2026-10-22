import 'dart:convert';
import 'dart:io';
import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver(
  timeout: const Duration(minutes: 2),
  responseDataCallback: (data) async {
    final folder = Platform.environment['AURACHAT_TEST_SHOTS'];
    if (folder == null) {
      throw StateError(
        'Set AURACHAT_TEST_SHOTS to the screenshot artifact directory',
      );
    }
    await Directory(folder).create(recursive: true);
    final previews = data?['previews'] as List?;
    if (previews == null || previews.length != 2) {
      throw StateError('Missing native previews');
    }
    for (final preview in previews) {
      final name = preview['name'] as String;
      await File(
        '$folder${Platform.pathSeparator}$name.png',
      ).writeAsBytes(base64Decode(preview['png'] as String));
    }
  },
);
