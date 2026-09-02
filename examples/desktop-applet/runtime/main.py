import json
import os
import sys
import time


def emit(event: dict[str, object]) -> None:
    print(f"AW_EVENT {json.dumps(event, ensure_ascii=False)}", flush=True)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing Host-provided environment: {name}")
    return value


def main() -> int:
    app_id = required_environment("AW_APP_ID")
    task_id = required_environment("AW_TASK_ID")
    required_environment("AW_LEASE")
    required_environment("AW_RPC_ENDPOINT")
    work_directory = required_environment("AW_WORK_DIRECTORY")

    emit({"type": "log", "level": "info", "message": f"started {app_id}/{task_id}"})
    for step in range(1, 6):
        time.sleep(0.1)
        emit({"type": "progress", "value": step / 5, "label": f"step {step}/5"})
    emit(
        {
            "type": "result",
            "data": {"message": "Hello from the isolated Runner", "workDirectory": work_directory},
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"desktop applet failed: {error}", file=sys.stderr, flush=True)
        raise
