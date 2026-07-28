pub(crate) fn should_activate_rdp_overlay(
    click_targets_rdp: bool,
    foreground_is_rdp: bool,
    foreground_covers_click: bool,
) -> bool {
    click_targets_rdp && (foreground_is_rdp || !foreground_covers_click)
}

#[cfg(test)]
mod tests {
    use super::should_activate_rdp_overlay;

    #[test]
    fn does_not_activate_through_a_foreground_app_covering_the_click() {
        assert!(!should_activate_rdp_overlay(true, false, true));
    }

    #[test]
    fn activates_an_exposed_rdp_area_while_another_app_is_foreground() {
        assert!(should_activate_rdp_overlay(true, false, false));
    }

    #[test]
    fn keeps_rdp_clicks_active_when_nextdesk_is_already_foreground() {
        assert!(should_activate_rdp_overlay(true, true, true));
    }

    #[test]
    fn ignores_clicks_that_do_not_target_rdp() {
        assert!(!should_activate_rdp_overlay(false, false, false));
    }
}
