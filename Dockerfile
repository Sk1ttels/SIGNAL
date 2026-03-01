FROM nginx:alpine

RUN apk add --no-cache bash

COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 8080

CMD ["/bin/bash", "-c", "export PORT=${PORT:-8080} && envsubst '$PORT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
