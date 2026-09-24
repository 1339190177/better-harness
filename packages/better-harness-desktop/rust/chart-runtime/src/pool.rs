use crate::ChartResult;

const CAPACITY: usize = 3;

pub(crate) struct Slot<T> {
    pub resource: Option<T>,
    width: u32,
    height: u32,
    frame_id: Option<u32>,
    uncertain: bool,
}

pub(crate) struct SurfacePool<T> {
    slots: Vec<Slot<T>>,
    rendered: u32,
    released: u32,
}

impl<T> Default for SurfacePool<T> {
    fn default() -> Self {
        Self { slots: Vec::with_capacity(CAPACITY), rendered: 0, released: 0 }
    }
}

impl<T> SurfacePool<T> {
    pub fn prepare(&mut self, width: u32, height: u32, create: impl FnOnce() -> ChartResult<T>) -> ChartResult<usize> {
        if self.has_uncertain() {
            return Err("GPU_FAULT: 未确认提交完成的池不得复用".into());
        }
        if self.rendered == u32::MAX {
            // 不复用帧号，防止旧的重复回执错误释放新租约。
            return Err("FRAME_ID_EXHAUSTED: 请释放资源并重建图表".into());
        }
        let matching = self.slots.iter().position(|s| {
            s.frame_id.is_none() && s.resource.is_some() && s.width == width && s.height == height
        });
        if let Some(index) = matching { return Ok(index); }
        let index = if let Some(index) = self.slots.iter().position(|s| s.frame_id.is_none()) {
            index
        } else if self.slots.len() < CAPACITY {
            self.slots.push(Slot { resource: None, width, height, frame_id: None, uncertain: false });
            self.slots.len() - 1
        } else {
            return Err("SURFACE_BUSY: 三个输出槽均在租用，等待 allReferencesReleased".into());
        };
        let slot = &mut self.slots[index];
        // 只替换空闲槽；先销毁旧资源，确保分配瞬间也不会出现第四个 surface。
        drop(slot.resource.take());
        slot.resource = Some(create()?);
        slot.width = width;
        slot.height = height;
        Ok(index)
    }

    pub fn get(&self, index: usize) -> &T {
        self.slots[index].resource.as_ref().expect("槽位已完成资源分配")
    }

    pub fn begin_gpu(&mut self, index: usize) {
        self.slots[index].uncertain = true;
    }

    pub fn complete_gpu(&mut self, index: usize) {
        self.slots[index].uncertain = false;
    }

    pub fn has_uncertain(&self) -> bool { self.slots.iter().any(|s| s.uncertain) }

    pub fn lease(&mut self, index: usize) -> u32 {
        let slot = &mut self.slots[index];
        assert!(slot.resource.is_some() && slot.frame_id.is_none() && !slot.uncertain);
        self.rendered += 1;
        slot.frame_id = Some(self.rendered);
        self.rendered
    }

    pub fn release(&mut self, frame_id: u32) -> bool {
        if let Some(slot) = self.slots.iter_mut().find(|s| s.frame_id == Some(frame_id)) {
            slot.frame_id = None;
            self.released += 1;
            true
        } else { false }
    }

    pub fn allocated(&self) -> u32 { self.slots.iter().filter(|s| s.resource.is_some()).count() as u32 }
    pub fn in_flight(&self) -> u32 { self.slots.iter().filter(|s| s.frame_id.is_some()).count() as u32 }
    pub fn rendered(&self) -> u32 { self.rendered }
    pub fn released(&self) -> u32 { self.released }

    pub fn clear(&mut self) -> ChartResult<()> {
        if self.in_flight() != 0 {
            return Err("SURFACE_BUSY: dispose 必须等待全部输出租约释放".into());
        }
        self.preserve_external();
        self.slots.clear();
        Ok(())
    }

    fn preserve_external(&mut self) {
        for slot in &mut self.slots {
            if slot.frame_id.is_some() || slot.uncertain {
                // JS GC 不等于全引用回执；GPU 超时也不等于提交完成。异常路径保留到进程退出。
                // 正常 releaseFrame → dispose 无泄漏；故障资源不能被超时回收或强制清池。
                if let Some(resource) = slot.resource.take() { std::mem::forget(resource); }
            }
        }
    }
}

impl<T> Drop for SurfacePool<T> {
    fn drop(&mut self) { self.preserve_external(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};

    struct Resource(Rc<Cell<u32>>);
    impl Drop for Resource {
        fn drop(&mut self) { self.0.set(self.0.get() + 1); }
    }

    #[test]
    fn dropping_chart_preserves_leased_resources_but_frees_idle_ones() {
        let drops = Rc::new(Cell::new(0));
        let mut pool = SurfacePool::default();
        let a = pool.prepare(10, 10, || Ok(Resource(drops.clone()))).unwrap();
        pool.lease(a);
        pool.prepare(10, 10, || Ok(Resource(drops.clone()))).unwrap();
        drop(pool);
        assert_eq!(drops.get(), 1);
    }

    #[test]
    fn failed_replacement_leaves_recoverable_empty_slot_without_leaking() {
        let drops = Rc::new(Cell::new(0));
        let mut pool = SurfacePool::default();
        pool.prepare(10, 10, || Ok(Resource(drops.clone()))).unwrap();
        assert!(pool.prepare(20, 20, || Err("模拟分配失败".into())).is_err());
        assert_eq!(drops.get(), 1);
        assert_eq!((pool.allocated(), pool.in_flight()), (0, 0));
        let slot = pool.prepare(20, 20, || Ok(Resource(drops.clone()))).unwrap();
        let id = pool.lease(slot);
        assert!(pool.clear().is_err());
        assert!(pool.release(id));
        pool.clear().unwrap();
        assert_eq!(drops.get(), 2);
    }

    #[test]
    fn backpressure_does_not_call_allocator_or_reuse_frame_ids() {
        let mut pool = SurfacePool::default();
        for _ in 0..3 {
            let slot = pool.prepare(10, 10, || Ok(())).unwrap();
            pool.lease(slot);
        }
        assert!(pool.prepare(20, 20, || panic!("满池不允许调用分配器")).unwrap_err().contains("SURFACE_BUSY"));
        assert!(pool.release(2));
        let slot = pool.prepare(20, 20, || Ok(())).unwrap();
        assert_eq!(pool.lease(slot), 4);
        assert!(!pool.release(2));
        assert_eq!(pool.in_flight(), 3);
    }

    #[test]
    fn exhausted_frame_counter_cannot_wrap_and_release_new_lease() {
        let mut pool = SurfacePool::<()>::default();
        pool.rendered = u32::MAX;
        assert!(pool.prepare(1, 1, || Ok(())).unwrap_err().contains("FRAME_ID_EXHAUSTED"));
        assert_eq!(pool.rendered(), u32::MAX);
    }

    #[test]
    fn unknown_submission_is_not_reused_or_destroyed_even_without_a_lease() {
        for explicit_dispose in [false, true] {
            let drops = Rc::new(Cell::new(0));
            let mut pool = SurfacePool::default();
            let a = pool.prepare(10, 10, || Ok(Resource(drops.clone()))).unwrap();
            let lease = pool.lease(a);
            let b = pool.prepare(10, 10, || Ok(Resource(drops.clone()))).unwrap();
            pool.begin_gpu(b);
            assert!(pool.prepare(20, 20, || panic!("故障后禁止分配")).is_err());
            assert!(pool.clear().is_err());
            assert_eq!(drops.get(), 0);
            assert!(!pool.release(lease + 1));
            assert!(pool.has_uncertain());
            if explicit_dispose {
                assert!(pool.release(lease));
                pool.clear().unwrap();
            }
            drop(pool);
            assert_eq!(drops.get(), u32::from(explicit_dispose));
        }
    }

    #[test]
    fn confirmed_submission_can_be_leased_released_and_destroyed() {
        let drops = Rc::new(Cell::new(0));
        let mut pool = SurfacePool::default();
        let slot = pool.prepare(10, 10, || Ok(Resource(drops.clone()))).unwrap();
        pool.begin_gpu(slot);
        pool.complete_gpu(slot);
        let id = pool.lease(slot);
        assert!(pool.release(id));
        pool.clear().unwrap();
        assert_eq!(drops.get(), 1);
    }
}
