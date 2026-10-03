# Canonical bug_hunting action registry fixture for CI validation
_ACTIONS = {
    "plan",
    "recon",
    "subdomain_enum",
    "port_scan",
    "url_collect",
    "vuln_scan",
    "report",
    "learning_loop",
    "feature_map",
    "request_analysis",
    "js_review",
    "report_assist",
    "feedback_loop",
    "full_pipeline",
    "platform_scan",
}

_NO_TARGET_ACTIONS = {
    "learning_loop", "feature_map", "request_analysis", "js_review", "report_assist", "feedback_loop"
}

def get_unknown_action_response():
    return {
        "status": False,
        "summary": "Unknown action",
        "result": {
            "available_actions": sorted(_ACTIONS),
        },
    }
