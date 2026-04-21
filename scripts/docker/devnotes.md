# building the images yourself

if you want to build the image from scratch then you've come to the right place -- however if you only want to make small modifications to the official image then jump down to [modifying an image](#modifying-an-image) or possibly [modding on the fly](#modding-on-the-fly)

```bash
./make.sh hclean pull img push
```
will download the latest copyparty-sfx.py from github unless you have [built it from scratch](../../docs/devnotes.md#just-the-sfx) and then build all the images based on that

deprecated alternative: run `make` to use the makefile however that uses docker instead of podman and only builds x86_64

`make.sh` is necessarily(?) overengineered because:
* podman keeps burning dockerhub pulls by not using the cached images (`--pull=never` does not apply to manifests)
* podman cannot build from a local manifest, only local images or remote manifests

but I don't really know what i'm doing here 💩

* auth for pushing images to repos;  
  `podman login docker.io`  
  `podman login ghcr.io -u 9001`  
  [about gchq](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) (takes a classic token as password)


## building on alpine

```bash
apk add podman{,-docker}
rc-update add cgroups
service cgroups start
vim /etc/containers/storage.conf  # driver = "btrfs"
modprobe tun
echo ed:100000:65536 >/etc/subuid
echo ed:100000:65536 >/etc/subgid
apk add qemu-openrc qemu-tools qemu-{arm,armeb,aarch64,s390x,ppc64le}
rc-update add qemu-binfmt
service qemu-binfmt start
```


# modifying an image

if you want to make a small change to the official image, for example [install a python package you need](https://github.com/9001/copyparty/issues/479), then the best approach is to build a new image based on the official one. There's a quick summary below, but check the internets if you want a better walkthrough.

**NOTE:** the `min` image is **not** a good idea to modify (brittle from shoehorning); use any of the other variants instead (`im`, `ac`, `iv`, `dj`)

first, create a new folder, and then create a new blank textfile named `Dockerfile` inside that folder:

```bash
mkdir customparty
cd customparty
nano Dockerfile
```

assuming you want to install the python-package "[requests](https://pypi.org/project/requests/)", which in [alpine](https://alpinelinux.org/) is called [py3-requests](https://pkgs.alpinelinux.org/package/edge/main/x86_64/py3-requests), then put the following contents into your `Dockerfile`:

```docker
FROM docker.io/copyparty/ac:latest
RUN apk add --no-cache py3-requests
```

build the new docker-image with the additional package you added:

```bash
docker pull docker.io/copyparty/ac:latest
docker build -t customparty .
```

now you can run the image `localhost/customparty:latest` which is `copyparty/ac:latest` with your changes

**one important thing to remember:** Whenever you want to update your copyparty version, you must rebuild that image by running those two docker commands (`pull` and `build`) in that folder


## modding on the fly

if you are not able to build your own image, then it is also possible to apply *some* changes as the image is starting up, before copyparty itself is launched. This is hacky but mostly-safe if done correctly

**NOTE:** the `min` image is **not** a good idea to modify (brittle from shoehorning); use any of the other variants instead (`im`, `ac`, `iv`, `dj`)

you should have a docker-volume which is mapped to `/cfg` in the container; in that volume, create a shellscript named (for example) `strikk-og-binders.sh` and then ensure that the docker-container is always executed with the environment-variable `DI_PREPARTY` set to `strikk-og-binders.sh`

* if you use docker-compose then see the [LD_PRELOAD](https://github.com/9001/copyparty/blob/hovudstraum/docs/examples/docker/basic-docker-compose/docker-compose.yml) example

**NOTE:** if you are doing this to [install a package you need](https://github.com/9001/copyparty/issues/479), then please make sure you **do not** download the package every time you restart copyparty, because that would result in excessive strain on Alpine's poor servers. You should cache the package locally. Here's an example `strikk-og-binders.sh` with caching, using [exiftool](https://pkgs.alpinelinux.org/package/edge/community/x86_64/exiftool) and [py3-requests](https://pkgs.alpinelinux.org/package/edge/main/x86_64/py3-requests) as the example packages to install

```bash
set -e  # if something below goes wrong, then panic and crash
#set -x  # uncomment this to debug (enable command-logging)

# packages to install
pkgs="exiftool py3-requests"

# if the docker-image is newer than the cache, then delete the cache
[ /z/initcfg -nt /cfg/apks/t ] && rm -rf /cfg/apks

# if the cache has the wrong packages, then delete the cache
grep -qF "$pkgs" /cfg/apks/t || rm -rf /cfg/apks

# if there is a cache, then just install those packages (remove -q to debug)
[ -e /cfg/apks ] && exec apk add -q --progress=no /cfg/apks/*.apk

# there is no cache; need to download+cache+install
mkdir /cfg/apks
apk add --cache-predownload --cache-dir /cfg/apks --progress=no $pkgs
echo "$pkgs" >/cfg/apks/t
touch -r /z/initcfg /cfg/apks/t
```

security-wise this is safe because apk-files are signed and thus tamper-proof
