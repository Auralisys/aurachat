use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize};

/// Normal bounds are physical pixels; maximizing never replaces them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

impl WindowGeometry {
    pub fn valid(&self) -> bool {
        self.width > 0 && self.height > 0
    }

    pub fn fit(mut self, x: i32, y: i32, width: u32, height: u32, scale: f64) -> Self {
        self.width = self.width.max((720.0 * scale) as u32).min(width);
        self.height = self.height.max((680.0 * scale) as u32).min(height);
        self.x = (self.x as i64).clamp(x as i64, x as i64 + (width - self.width) as i64) as i32;
        self.y = (self.y as i64).clamp(y as i64, y as i64 + (height - self.height) as i64) as i32;
        self
    }

    pub fn capture(&mut self, position: PhysicalPosition<i32>, size: PhysicalSize<u32>, maximized: bool) {
        if size.width == 0 || size.height == 0 { return; }
        if !maximized {
            self.x = position.x;
            self.y = position.y;
            self.width = size.width;
            self.height = size.height;
        }
        self.maximized = maximized;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_keeps_window_visible_after_monitor_changes() {
        let saved = WindowGeometry { x: 4000, y: -900, width: 2400, height: 1800, maximized: false };
        let fitted = saved.fit(0, 40, 1366, 728, 1.0);
        assert_eq!((fitted.x, fitted.y, fitted.width, fitted.height), (0, 40, 1366, 728));
        let negative = WindowGeometry { x: -1800, y: 80, width: 900, height: 700, maximized: false };
        assert_eq!(negative.clone().fit(-1920, 0, 1920, 1080, 1.0), negative);
        let tiny = negative.fit(0, 0, 600, 400, 2.0);
        assert_eq!((tiny.width, tiny.height), (600, 400));
    }

    #[test]
    fn maximize_and_minimize_preserve_normal_bounds() {
        let mut geometry = WindowGeometry { x: 100, y: 120, width: 1080, height: 880, maximized: false };
        geometry.capture(PhysicalPosition::new(0, 0), PhysicalSize::new(1920, 1080), true);
        assert_eq!((geometry.x, geometry.y, geometry.width, geometry.height), (100, 120, 1080, 880));
        assert!(geometry.maximized);
        geometry.capture(PhysicalPosition::new(-32000, -32000), PhysicalSize::new(0, 0), false);
        assert!(geometry.maximized);
        geometry.capture(PhysicalPosition::new(150, 160), PhysicalSize::new(900, 700), false);
        assert_eq!((geometry.x, geometry.y, geometry.width, geometry.height), (150, 160, 900, 700));
        assert!(!geometry.maximized);
        let restored: WindowGeometry = serde_json::from_value(serde_json::to_value(&geometry).unwrap()).unwrap();
        assert_eq!(restored, geometry);
    }
}
