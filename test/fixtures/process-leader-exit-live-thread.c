#include <pthread.h>
#include <stdio.h>
#include <unistd.h>

static void *keep_working(void *unused) {
	(void)unused;
	for (;;) sleep(1);
	return NULL;
}

int main(void) {
	pthread_t worker;
	if (pthread_create(&worker, NULL, keep_working, NULL) != 0) return 2;
	// The thread-group leader becomes a zombie, but the worker can still run.
	pthread_exit(NULL);
}
