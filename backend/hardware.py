import os
import psutil
import torch

def get_cpu_count():
    return os.cpu_count() or 1

def get_ram_gb():
    return int(psutil.virtual_memory().total / (1024 ** 3))

def get_vram_gb():
    if not torch.cuda.is_available():
        return 0
    props = torch.cuda.get_device_properties(0)
    return int(props.total_memory / (1024 ** 3))

def auto_worker_plan():
    cpu = get_cpu_count()
    ram = get_ram_gb()
    vram = get_vram_gb()

    sync = min(max(2, cpu // 2), 8)
    extract = min(max(2, cpu // 3), 6)
    embed = 1 if vram >= 8 else 0
    cluster = 1

    sync = int(os.getenv("SYNC_WORKERS", sync))
    extract = int(os.getenv("EXTRACT_WORKERS", extract))
    embed = int(os.getenv("EMBED_WORKERS", embed))
    cluster = int(os.getenv("CLUSTER_WORKERS", cluster))

    return {
        "cpu": cpu,
        "ram_gb": ram,
        "vram_gb": vram,
        "sync_workers": sync,
        "extract_workers": extract,
        "embed_workers": embed,
        "cluster_workers": cluster,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }
