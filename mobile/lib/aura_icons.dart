import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// Shared desktop glyphs; source hashes are kept in assets/icons/provenance.json.
class AuraGlyph extends StatelessWidget {
  const AuraGlyph(this.name, {super.key, this.size = 22, this.color});
  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => SvgPicture.asset(
    'assets/icons/$name.svg', width: size, height: size,
    colorFilter: ColorFilter.mode(color ?? IconTheme.of(context).color ?? Colors.white, BlendMode.srcIn),
    excludeFromSemantics: true,
  );
}
