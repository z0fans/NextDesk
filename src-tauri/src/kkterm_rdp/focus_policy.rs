pub(crate) fn should_focus_rdp_control(foreground_is_owner: bool) -> bool {
    foreground_is_owner
}

#[cfg(test)]
mod tests {
    use super::should_focus_rdp_control;

    #[test]
    fn passive_input_does_not_focus_rdp_while_another_app_is_foreground() {
        assert!(!should_focus_rdp_control(false));
    }

    #[test]
    fn input_can_focus_rdp_when_nextdesk_is_already_foreground() {
        assert!(should_focus_rdp_control(true));
    }

    #[test]
    fn windows_activex_host_is_a_nonactivating_owned_popup() {
        let source = include_str!("windows.rs");
        assert!(source.contains("WS_POPUP | WS_VISIBLE"));
        assert!(source.contains("WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE"));
        assert!(!source.contains("WS_CHILD | WS_VISIBLE"));
    }
}
