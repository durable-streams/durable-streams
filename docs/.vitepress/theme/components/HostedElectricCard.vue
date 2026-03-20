<template>
  <div class="hosting-cloud-card">
    <a class="hosting-cloud-link" href="https://dashboard.electric-sql.cloud"
        target="_blank">
      <div class="hosting-cloud-surface">
        <div class="hosting-cloud-content">
          <div class="hosting-cloud-icon">
            <img src="/img/icons/ddn.svg" alt="Electric" />
          </div>
          <div class="hosting-cloud-text">
            <h3>Electric Cloud</h3>
            <p>Scalable, turnkey hosting of Durable&nbsp;Streams.</p>
          </div>
          <div class="hosting-cloud-actions">
            <span class="hosting-cloud-button">Sign up now ↗</span>
          </div>
        </div>
      </div>
    </a>
  </div>
</template>

<style scoped>
.hosting-cloud-card {
  margin: 28px 0 34px;
  width: 100%;
}
.hosting-cloud-card:hover {
  border: none !important;
}

.hosting-cloud-link {
  color: inherit !important;
  display: block;
  text-decoration: none;
}

.hosting-cloud-surface {
  background:
    linear-gradient(to right, var(--vp-c-bg-soft) 45%, transparent 85%),
    linear-gradient(rgba(26, 27, 30, 0.5), rgba(26, 27, 30, 0.5)),
    url("/img/home/dashboard-stream.jpg") right top / auto 109% no-repeat,
    var(--vp-c-bg-soft);
  border: 1px solid rgba(42, 44, 52, 0.5);
  border-radius: 12px;
  overflow: hidden;
  padding: 40px 30% 48px 32px;
  transition:
    border-color 0.18s ease,
    transform 0.18s ease;
}

.hosting-cloud-link:hover .hosting-cloud-surface {
  border-color: rgba(208, 188, 255, 0.3);
  transform: translateY(-1px);
}

.hosting-cloud-content {
  align-items: flex-start;
  display: flex;
  flex-direction: column;
  gap: 20px;
  text-align: left;
}

.hosting-cloud-icon img {
  width: 64px;
}

.hosting-cloud-text h3 {
  border-top: 0 !important;
  font-size: 1.5rem;
  margin: 0 0 12px;
  padding-top: 0 !important;
}

.hosting-cloud-text p {
  color: var(--vp-c-text-2);
  font-size: 15px;
  font-weight: 500;
  line-height: 1.6;
  margin: 0;
  max-width: 520px;
}

.hosting-cloud-actions {
  align-items: center;
  display: flex;
  flex-direction: row;
  gap: 20px;
}

.hosting-cloud-button {
  align-items: center;
  background: rgb(153, 143, 231);
  border-radius: 999px;
  color: #fff;
  display: inline-flex;
  font-size: 15px;
  font-weight: 600;
  min-height: 44px;
  padding: 0 34px;
  transition:
    background-color 0.18s ease,
    transform 0.18s ease;
}

.hosting-cloud-link:hover .hosting-cloud-button {
  background: rgb(126, 120, 219);
  transform: translateY(-1px);
}

@media (max-width: 768px) {
  .hosting-cloud-surface {
    background:
      linear-gradient(to right, var(--vp-c-bg-soft) 40%, transparent 85%),
      linear-gradient(rgba(26, 27, 30, 0.6), rgba(26, 27, 30, 0.6)),
      url("/img/home/dashboard-stream.jpg") right top / auto 109% no-repeat,
      var(--vp-c-bg-soft);
    padding: 40px 32px 46px;
  }

  .hosting-cloud-icon img {
    height: 48px;
    width: 48px;
  }

  .hosting-cloud-text h3 {
    font-size: 1.25rem;
  }
}

@media (max-width: 518px) {
  .hosting-cloud-surface {
    background:
      linear-gradient(to right, var(--vp-c-bg-soft) 40%, transparent 85%),
      linear-gradient(rgba(26, 27, 30, 0.8), rgba(26, 27, 30, 0.8)),
      url("/img/home/dashboard-stream.jpg") right top / auto 109% no-repeat,
      var(--vp-c-bg-soft);
    padding: 32px 24px 40px;
  }
}
</style>
